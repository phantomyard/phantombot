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
  /**
   * Browser origins allowed to upgrade. A no-`Origin` client (CLI/tooling) and
   * localhost origins (the dev PWA) are always allowed; any other browser
   * `Origin` must appear here or the upgrade is refused with 403.
   */
  allowedOrigins?: string[];
}

/**
 * Decide whether a WebSocket upgrade may proceed, based on its `Origin` header.
 *
 * The bridge binds to loopback, but a browser will still send WebSocket
 * handshakes to `ws://127.0.0.1:<port>` from ANY site the user is visiting, and
 * WebSocket is exempt from CORS preflight — so without this gate an arbitrary
 * page could subscribe to every wrap broadcast and inject `EVENT` frames for the
 * node to forward. The policy:
 *
 *   - No `Origin` header  → allow. Non-browser clients (CLI probes, the werift
 *     test harness, curl) don't send one; browsers always do.
 *   - Literal `Origin: null` → DENY. This is what a browser emits for an *opaque*
 *     origin (sandboxed iframe, `data:`/`file:` page, some cross-origin
 *     redirects); a hostile page can provoke it, so opaque origins are untrusted.
 *   - `localhost` / `127.0.0.1` / `[::1]` origin (any scheme/port) → allow. This
 *     is the user's own dev PhantomChat, not a remote site.
 *   - Origin in `allowedOrigins` (exact match) → allow (e.g. prod PhantomChat).
 *   - Anything else → deny.
 */
export function isOriginAllowed(
  origin: string | null | undefined,
  allowedOrigins: readonly string[],
): boolean {
  // Genuinely absent Origin header: not a browser cross-site request. (Bun's
  // req.headers.get("origin") returns real null when the header is absent, which
  // is distinct from a browser sending the literal string "null".)
  if (origin === null || origin === undefined || origin === "") return true;
  // A literal "null" Origin is a browser *opaque* origin (sandboxed iframe,
  // data:/file: page, some cross-origin redirects). NOT a non-browser tell — a
  // hostile page can provoke it to slip the gate, so refuse it as untrusted.
  if (origin === "null") return false;

  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    // Unparseable Origin → treat as hostile, refuse.
    return false;
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
    return true;
  }
  return allowedOrigins.includes(origin);
}

/** Per-socket data. Empty today; a hook for future auth/handshake state. */
type SocketData = Record<string, never>;

export class LocalBridge {
  private readonly port: number;
  private readonly host: string;
  private readonly onOutbound: (frame: ParsedEventFrame, raw: string) => void;
  private readonly allowedOrigins: readonly string[];
  private server: Server<SocketData> | null = null;
  private readonly clients = new Set<ServerWebSocket<SocketData>>();

  constructor(opts: LocalBridgeOptions) {
    this.port = opts.port;
    this.host = opts.host ?? "127.0.0.1";
    this.onOutbound = opts.onOutbound;
    this.allowedOrigins = opts.allowedOrigins ?? [];
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
        // Refuse cross-site browser upgrades BEFORE upgrading — a visited page
        // must not be able to attach to the local node (see isOriginAllowed).
        const origin = req.headers.get("origin");
        if (!isOriginAllowed(origin, self.allowedOrigins)) {
          log.warn(`[p2p] bridge refused upgrade from origin ${origin}`);
          return new Response("phantombot p2p bridge: origin not allowed", { status: 403 });
        }
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
