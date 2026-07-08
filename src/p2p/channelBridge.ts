/**
 * In-process bridge between the P2P WebRTC node and the phantomchat channel
 * (phantomyard/phantombot#61 — the WebRTC + relay-fallback rewrite).
 *
 * BACKGROUND. The original P2P node (#258) was a DUMB relay for a *co-located
 * browser PWA*: it moved opaque gift-wraps between a `ws://127.0.0.1` bridge
 * (the browser) and remote peer nodes. A headless persona (Lena/Kai/Megan) has
 * no co-located browser, so that ws bridge had no consumer — inbound WebRTC
 * frames were `broadcast()` into the void, the persona never saw them, and every
 * conversation silently fell back to the relay. That made a `webrtc: true`
 * capability advert a LIE: the badge could go green while messages only ever
 * arrived over the relay (the false-green Kai's review caught).
 *
 * FIX. For a headless persona the "local endpoint" is not a browser — it is the
 * persona's OWN phantomchat channel, in the same process. This bridge wires the
 * two directly, with zero sockets:
 *
 *   peer node ─WebRTC─▶ P2PNode ─broadcast()─▶ ChannelBridge ─▶ channel onWrap
 *   channel publishWrap ─▶ ChannelBridge ─routeOutbound()─▶ P2PNode ─WebRTC─▶ peer
 *
 * It is the SAME `BridgePort` contract the node already drives, so `node.ts`
 * stays transport-agnostic and unchanged. The gift-wrap stays sealed end-to-end
 * — this bridge only moves the `["EVENT", wrap]` frame between the node's
 * router and the channel's ingest; it never decrypts.
 *
 * SAFETY — why the redundant path can't double-process. The relay remains the
 * delivery floor: the channel subscribes to relays AND now also receives the
 * SAME gift-wrap over WebRTC. The channel's `onWrap` dedups by wrap event id
 * (and rumor id), and gates on EOSE (`live`), so a wrap that arrives over both
 * transports runs exactly one turn — whichever copy lands first wins, the other
 * is a free no-op. WebRTC just makes it faster; it never changes the outcome.
 */

import { log } from "../lib/logger.ts";
import type { NTNostrEvent } from "../lib/nostrCrypto.ts";
import { buildEventFrame, parseEventFrame, type ParsedEventFrame } from "./frame.ts";
import type { BridgePort } from "./node.ts";

/** The channel's inbound gift-wrap handler (its `onWrap`), or null when idle. */
export type WrapSink = (event: NTNostrEvent) => void | Promise<void>;

/**
 * A `BridgePort` whose "local side" is the persona's phantomchat channel rather
 * than a `ws://localhost` socket. Drop-in for `LocalBridge` in `buildP2PNode`.
 *
 * The bridge is created BEFORE the node (so the channel + transport can be wired
 * to it at their own construction), then the node injects its outbound router
 * via `setRouter` when `buildP2PNode` runs `createBridge`. This late injection
 * breaks the otherwise-circular dependency (the bridge needs the node's router;
 * the node needs the bridge).
 */
export class ChannelBridge implements BridgePort {
  /** The node's outbound router, injected by `buildP2PNode` via `setRouter`. */
  private onOutbound: ((frame: ParsedEventFrame, raw: string) => void) | null = null;
  /** The channel's `onWrap`, registered while the channel is listening. */
  private sink: WrapSink | null = null;

  /**
   * There is no ws listener, so no bound port. Kept at 0 to satisfy the
   * `BridgePort` contract; nothing reads it now that the capability advert is a
   * bare `{ webrtc: true }` (post-#61) with no loopback port.
   */
  readonly boundPort = 0;

  /**
   * Inject the node's outbound router. Called once by `buildP2PNode` inside the
   * node's `createBridge` seam, so the node stays transport-agnostic.
   */
  setRouter(onOutbound: (frame: ParsedEventFrame, raw: string) => void): void {
    this.onOutbound = onOutbound;
  }

  /** Nothing to open — the channel drives its own relay lifecycle. */
  start(): void {}

  /** Detach the channel sink so a stopped node can't feed a dead listener. */
  stop(): void {
    this.sink = null;
  }

  /**
   * Register (or clear) the channel's inbound handler. The channel calls this
   * with its `onWrap` when `listen()` starts, and with `null` on abort, so an
   * inbound WebRTC frame is only ever fed into a live listener.
   */
  setSink(sink: WrapSink | null): void {
    this.sink = sink;
  }

  /** Whether a channel is currently attached (the node's "local client"). */
  clientCount(): number {
    return this.sink ? 1 : 0;
  }

  /**
   * An inbound frame arrived off a peer's data channel. Parse the `["EVENT",
   * wrap]` and hand the gift-wrap to the channel's ingest — the SAME `onWrap`
   * the relay subscription feeds, so dedup + the live-gate apply uniformly.
   * Returns the number of sinks fed (0 or 1) to match `BridgePort.broadcast`.
   * Never throws: a malformed frame or a rejecting handler is logged and dropped
   * so a bad peer frame can't crash the node's receive path.
   */
  broadcast(frame: string): number {
    const parsed = parseEventFrame(frame);
    if (!parsed) return 0;
    const sink = this.sink;
    if (!sink) return 0;
    try {
      // onWrap may be async; like the channel's own backfill poll we fire it and
      // don't await — errors are handled inside onWrap, and a rejected promise is
      // caught here defensively.
      void Promise.resolve(sink(parsed.wrap)).catch((err) => {
        log.debug(`[p2p] channel onWrap rejected: ${String(err)}`);
      });
    } catch (err) {
      log.debug(`[p2p] channel onWrap threw: ${String(err)}`);
      return 0;
    }
    return 1;
  }

  /**
   * The channel published a reply gift-wrap. Frame it as `["EVENT", wrap]` and
   * hand it to the node's router, which sends it to the recipient peer's data
   * channel (dialing on demand) — or drops it if the recipient is us (a
   * multi-device self-wrap, which has no remote peer). Best-effort: the relay
   * copy the channel also published is the guaranteed floor, so a routing miss
   * here just means that message went relay-only.
   */
  routeOutbound(event: NTNostrEvent): void {
    const route = this.onOutbound;
    if (!route) return; // node not wired yet (or disabled) — relay is the floor
    const raw = buildEventFrame(event);
    const parsed = parseEventFrame(raw);
    if (!parsed) {
      // Our own reply wrap failed the frame validity check — should never happen
      // (we just built it), but never let it throw into the publish path.
      log.debug("[p2p] outbound wrap failed frame validation — relay-only");
      return;
    }
    try {
      route(parsed, raw);
    } catch (err) {
      log.debug(`[p2p] outbound route failed: ${String(err)}`);
    }
  }
}
