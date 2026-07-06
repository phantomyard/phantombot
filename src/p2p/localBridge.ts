/**
 * The Tier-1 local endpoint: a `ws://localhost:<port>` server the same-machine
 * PhantomChat PWA connects to (phantomyard/phantombot#258, phantomchat#61).
 *
 * `localhost` is a secure context, so an HTTPS-served PWA is allowed to open a
 * plain `ws://localhost` socket to it (this is NOT blocked as mixed content the
 * way `ws://<LAN-IP>` would be). The bridge is deliberately dumb:
 *
 *   PWA → bridge : the PWA ships an outgoing message as a Nostr relay frame,
 *                  `["EVENT", <gift-wrap>]`. The bridge parses it, reads the
 *                  recipient off the wrap's p-tag, and hands it to `onOutbound`
 *                  (which the node routes to the right peer connection). The
 *                  wrap stays sealed — the bridge never decrypts it.
 *   bridge → PWA : inbound wraps that arrived from peers are broadcast to every
 *                  connected local socket as the same `["EVENT", wrap]` frame,
 *                  which the PWA feeds straight into its relay-pool ingest.
 *
 * Binds to loopback ONLY (127.0.0.1) — never a routable interface — so nothing
 * off the machine can reach it. Built on Bun's native WebSocket server (no extra
 * dependency, and it compiles into the single binary).
 */

import type { Server, ServerWebSocket } from "bun";

import { log } from "../lib/logger.ts";
import { parseEventFrame, type ParsedEventFrame } from "./frame.ts";

export interface LocalBridgeOptions {
  /** Loopback port to listen on. Defaults handled by the caller. */
  port: number;
  /** Loopback host. Defaults to 127.0.0.1; never bind a routable interface. */
  host?: string;
  /** An outgoing PWA frame was received and parsed. */
  onOutbound: (frame: ParsedEventFrame, raw: string) => void;
}

/** Per-socket data. Empty today; a hook for future auth/handshake state. */
type SocketData = Record<string, never>;

export class LocalBridge {
  private readonly port: number;
  private readonly host: string;
  private readonly onOutbound: (frame: ParsedEventFrame, raw: string) => void;
  private server: Server<SocketData> | null = null;
  private readonly clients = new Set<ServerWebSocket<SocketData>>();

  constructor(opts: LocalBridgeOptions) {
    this.port = opts.port;
    this.host = opts.host ?? "127.0.0.1";
    this.onOutbound = opts.onOutbound;
  }

  /** The port the bridge is actually listening on (useful when port was 0). */
  get boundPort(): number {
    return this.server?.port ?? this.port;
  }

  /** How many local PWA sockets are connected right now. */
  clientCount(): number {
    return this.clients.size;
  }

  /**
   * Start listening. Throws if the port is already in use (e.g. a second node
   * on the same machine) — the caller decides whether that is fatal.
   */
  start(): void {
    if (this.server) return;
    const self = this;
    this.server = Bun.serve<SocketData>({
      port: this.port,
      hostname: this.host,
      fetch(req, server) {
        // Only accept WebSocket upgrades; everything else is a 426.
        if (server.upgrade(req, { data: {} })) return undefined;
        return new Response("phantombot p2p bridge: websocket only", { status: 426 });
      },
      websocket: {
        open(ws) {
          self.clients.add(ws);
          log.debug(`[p2p] bridge client connected (${self.clients.size} open)`);
        },
        message(_ws, message) {
          const raw = typeof message === "string" ? message : Buffer.from(message).toString("utf8");
          const frame = parseEventFrame(raw);
          if (!frame) {
            // Not a relay EVENT frame we route (could be a REQ/CLOSE); ignore.
            return;
          }
          try {
            self.onOutbound(frame, raw);
          } catch (err) {
            log.debug(`[p2p] bridge onOutbound threw: ${String(err)}`);
          }
        },
        close(ws) {
          self.clients.delete(ws);
          log.debug(`[p2p] bridge client disconnected (${self.clients.size} open)`);
        },
      },
    });
    log.info(`[p2p] local bridge listening on ws://${this.host}:${this.boundPort}`);
  }

  /**
   * Push an inbound frame to every connected local PWA socket. Returns the
   * number of sockets it was delivered to (0 when no PWA is attached — the wrap
   * is simply dropped, and the relay copy remains the PWA's source of truth).
   */
  broadcast(frame: string): number {
    let sent = 0;
    for (const ws of this.clients) {
      try {
        ws.send(frame);
        sent++;
      } catch (err) {
        log.debug(`[p2p] bridge broadcast failed to a client: ${String(err)}`);
      }
    }
    return sent;
  }

  /** Stop the server and drop all client sockets. Idempotent. */
  stop(): void {
    for (const ws of this.clients) {
      try {
        ws.close();
      } catch {
        // best-effort
      }
    }
    this.clients.clear();
    if (this.server) {
      this.server.stop(true);
      this.server = null;
    }
  }
}
