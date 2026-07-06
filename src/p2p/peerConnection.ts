/**
 * A single WebRTC connection to one remote phantombot node, built on werift —
 * the pure-TypeScript WebRTC stack (phantomyard/phantombot#258). werift is used
 * (not `node-datachannel`/Hyperswarm) because it is the only stack that survives
 * `bun build --compile` into the shipped single binary: no native `.node` addon,
 * verified end-to-end (ICE→DTLS→SCTP data-channel round-trip) inside a compiled
 * Bun binary during the spike.
 *
 * Each instance owns exactly one `RTCPeerConnection` and one data channel to one
 * peer, keyed by the peer's node pubkey. The class is transport-only: it moves
 * opaque gift-wrap frames (see `frame.ts`) back and forth and never inspects
 * them. SDP/ICE negotiation is delegated to an injected `sendSignal` callback
 * (wired to Nostr signaling by the node orchestrator), so this file has zero
 * Nostr knowledge and is unit-testable by looping two instances' signals in
 * memory — exactly how the spike proved it.
 */

import { RTCPeerConnection } from "werift";

import { log } from "../lib/logger.ts";
import type { CandidateSignal, SdpSignal, SignalMessage } from "./signaling.ts";

/** Connection lifecycle, collapsed to what the orchestrator cares about. */
export type PeerState = "new" | "connecting" | "connected" | "failed" | "closed";

export interface PeerConnectionOptions {
  /** The remote node's pubkey (hex) — identifies the peer for signaling. */
  peerHex: string;
  /**
   * Who initiates. The node with the lexicographically SMALLER pubkey is the
   * initiator (deterministic, so both sides agree without a round-trip and we
   * never double-offer). The initiator creates the data channel + offer; the
   * responder waits for the offer and answers.
   */
  initiator: boolean;
  /** ICE servers (public STUN). Empty = host candidates only (localhost/LAN). */
  iceServers: { urls: string }[];
  /** Publish a signal to the peer. Wired to Nostr signaling by the node. */
  sendSignal: (msg: SignalMessage) => void;
  /** An inbound data-channel frame arrived from the peer. */
  onFrame: (frame: string) => void;
  /** Connection state changed. */
  onState?: (state: PeerState) => void;
}

/** Data-channel label. Both sides must agree; the responder reads it off the offer. */
const DATA_CHANNEL_LABEL = "phantomchat-bridge";

export class PeerConnection {
  readonly peerHex: string;
  private readonly initiator: boolean;
  private readonly sendSignal: (msg: SignalMessage) => void;
  private readonly onFrame: (frame: string) => void;
  private readonly onStateCb?: (state: PeerState) => void;

  private pc: RTCPeerConnection;
  private channel: ReturnType<RTCPeerConnection["createDataChannel"]> | null = null;
  private state: PeerState = "new";
  private remoteDescriptionSet = false;
  /** ICE candidates that arrived before the remote description — flushed after. */
  private pendingCandidates: CandidateSignal[] = [];
  private closed = false;

  constructor(opts: PeerConnectionOptions) {
    this.peerHex = opts.peerHex;
    this.initiator = opts.initiator;
    this.sendSignal = opts.sendSignal;
    this.onFrame = opts.onFrame;
    this.onStateCb = opts.onState;

    this.pc = new RTCPeerConnection({ iceServers: opts.iceServers });
    this.wire();
  }

  /** Current collapsed connection state. */
  getState(): PeerState {
    return this.state;
  }

  /** Is the data channel open and ready to carry frames right now? */
  isReady(): boolean {
    return this.state === "connected" && this.channel?.readyState === "open";
  }

  private setState(next: PeerState): void {
    if (this.state === next || this.state === "closed") return;
    this.state = next;
    this.onStateCb?.(next);
  }

  private wire(): void {
    // Trickle local ICE candidates to the peer as they are gathered. `undefined`
    // signals end-of-candidates — nothing to send, so we skip it.
    this.pc.onIceCandidate.subscribe((candidate) => {
      if (!candidate || !candidate.candidate) return;
      this.sendSignal({
        t: "candidate",
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? null,
        sdpMLineIndex: candidate.sdpMLineIndex ?? null,
      });
    });

    this.pc.connectionStateChange.subscribe((s) => {
      // NOTE: transport `connected` is NOT the same as "ready to carry frames" —
      // the SCTP data channel opens slightly AFTER the ICE/DTLS transport
      // connects. We deliberately do NOT promote to `connected` here; that
      // happens on the data channel's `open` event (see `bindChannel`), which is
      // the point at which `send()` actually works. Promoting too early would
      // flush the outbox into a not-yet-open channel and silently drop frames.
      if (s === "failed" || s === "disconnected") {
        // A failed/disconnected transport is terminal for this attempt; the
        // orchestrator drops and can re-dial on the next outbound frame.
        this.setState("failed");
      } else if (s === "closed") {
        this.setState("closed");
      } else if (this.state !== "connected") {
        // new / connecting / transport-connected → still coming up. Never
        // downgrade once the channel has opened.
        this.setState("connecting");
      }
    });

    // The responder receives the channel the initiator created.
    this.pc.onDataChannel.subscribe((ch) => {
      this.bindChannel(ch);
    });
  }

  private bindChannel(ch: ReturnType<RTCPeerConnection["createDataChannel"]>): void {
    this.channel = ch;
    ch.onMessage.subscribe((msg) => {
      const text = typeof msg === "string" ? msg : Buffer.from(msg).toString("utf8");
      try {
        this.onFrame(text);
      } catch (err) {
        log.debug(`[p2p] onFrame handler threw for ${this.short()}: ${String(err)}`);
      }
    });
    ch.stateChanged.subscribe((s) => {
      if (s === "open") this.setState("connected");
    });
    if (ch.readyState === "open") this.setState("connected");
  }

  /**
   * Kick off negotiation. The initiator creates the data channel and sends an
   * offer; the responder does nothing here and waits for the offer to arrive via
   * `handleSignal`. Safe to call once.
   */
  async start(): Promise<void> {
    if (this.closed) return;
    this.setState("connecting");
    if (!this.initiator) return;
    try {
      const ch = this.pc.createDataChannel(DATA_CHANNEL_LABEL);
      this.bindChannel(ch);
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.sendSignal({ t: "offer", sdp: this.pc.localDescription?.sdp ?? offer.sdp });
    } catch (err) {
      log.warn(`[p2p] offer failed for ${this.short()}`, { error: String(err) });
      this.setState("failed");
    }
  }

  /** Feed an inbound signal (offer/answer/candidate/bye) from this peer. */
  async handleSignal(msg: SignalMessage): Promise<void> {
    if (this.closed) return;
    try {
      if (msg.t === "offer") await this.onOffer(msg);
      else if (msg.t === "answer") await this.onAnswer(msg);
      else if (msg.t === "candidate") await this.onCandidate(msg);
      else if (msg.t === "bye") this.close();
    } catch (err) {
      log.warn(`[p2p] handleSignal(${msg.t}) failed for ${this.short()}`, { error: String(err) });
      this.setState("failed");
    }
  }

  private async onOffer(msg: SdpSignal): Promise<void> {
    await this.pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
    this.remoteDescriptionSet = true;
    await this.flushCandidates();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.sendSignal({ t: "answer", sdp: this.pc.localDescription?.sdp ?? answer.sdp });
  }

  private async onAnswer(msg: SdpSignal): Promise<void> {
    await this.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
    this.remoteDescriptionSet = true;
    await this.flushCandidates();
  }

  private async onCandidate(msg: CandidateSignal): Promise<void> {
    // Candidates can race ahead of the remote description; buffer until it lands.
    if (!this.remoteDescriptionSet) {
      this.pendingCandidates.push(msg);
      return;
    }
    await this.addCandidate(msg);
  }

  private async flushCandidates(): Promise<void> {
    const pending = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const c of pending) await this.addCandidate(c);
  }

  private async addCandidate(msg: CandidateSignal): Promise<void> {
    await this.pc.addIceCandidate({
      candidate: msg.candidate,
      sdpMid: msg.sdpMid ?? undefined,
      sdpMLineIndex: msg.sdpMLineIndex ?? undefined,
    });
  }

  /**
   * Send an opaque frame to the peer over the data channel. Returns false if the
   * channel isn't open, so the orchestrator can fall back to another route.
   */
  send(frame: string): boolean {
    if (!this.isReady() || !this.channel) return false;
    try {
      this.channel.send(frame);
      return true;
    } catch (err) {
      log.debug(`[p2p] data-channel send failed for ${this.short()}: ${String(err)}`);
      return false;
    }
  }

  /** Tear down the connection. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.setState("closed");
    try {
      void this.pc.close();
    } catch (err) {
      log.debug(`[p2p] pc close failed for ${this.short()}: ${String(err)}`);
    }
  }

  private short(): string {
    return this.peerHex.slice(0, 8);
  }
}
