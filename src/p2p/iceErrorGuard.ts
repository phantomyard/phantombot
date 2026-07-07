/**
 * ICE UDP-socket error guard (phantomyard/phantombot#274).
 *
 * werift's ICE agent opens *connected* UDP (`dgram`) sockets for each candidate
 * pair. On Linux, when a datagram is sent to a host/port with nothing listening,
 * the kernel delivers an ICMP port/host-unreachable back on that connected
 * socket, which Node surfaces as an asynchronous `error` event on the socket
 * (`ECONNREFUSED` / `EHOSTUNREACH` / `ENETUNREACH`, syscall `recv`/`send`).
 *
 * werift does not attach an `error` listener to these sockets, so the event
 * propagates as an **uncaught exception** and kills the whole process. In
 * practice this fires constantly during normal ICE — every dead/stale candidate
 * (a moved LAN IP, a firewalled srflx probe) triggers one — so a single WebRTC
 * handshake reliably crash-loops the daemon: the peer connects, an ICE probe
 * bounces, the process exits 1, systemd respawns, repeat. That is exactly why a
 * P2P peer would connect and then never reply.
 *
 * These errors are *benign* — that candidate pair is simply unreachable and ICE
 * moves on to the next. The correct behaviour is to swallow them (debug-log) and
 * keep running. We scope the guard as tightly as possible: only errors that look
 * like a dgram send/recv syscall failure with a known unreachable code are
 * absorbed. Anything else re-throws, preserving the original crash-on-real-bug
 * semantics (a throw inside an `uncaughtException` handler is fatal to the
 * process, with the original stack).
 */

import { log } from "../lib/logger.ts";

/** dgram syscalls the ICE agent uses; a benign error must originate from one. */
const ICE_SYSCALLS = new Set(["recv", "send", "recvmsg", "sendmsg"]);

/**
 * Unreachable/transient codes the kernel raises for a connected UDP socket whose
 * peer isn't listening or isn't routable. All benign for ICE candidate probing.
 */
const ICE_BENIGN_CODES = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
  "EPERM", // some firewalls surface blocked sends as EPERM
]);

interface NodeSystemError extends Error {
  code?: string;
  syscall?: string;
}

/** True only for the narrow class of benign ICE UDP socket errors. */
export function isBenignIceSocketError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as NodeSystemError;
  return (
    typeof e.syscall === "string" &&
    ICE_SYSCALLS.has(e.syscall) &&
    typeof e.code === "string" &&
    ICE_BENIGN_CODES.has(e.code)
  );
}

let installed = false;

/**
 * Install the process-level guard exactly once. Idempotent across personas.
 * Benign ICE socket errors are logged at debug and swallowed; everything else
 * re-throws so a genuine bug still crashes loudly.
 */
export function installIceErrorGuard(): void {
  if (installed) return;
  installed = true;

  process.on("uncaughtException", (err) => {
    if (isBenignIceSocketError(err)) {
      const e = err as NodeSystemError;
      log.debug(`[p2p] ignoring benign ICE socket error: ${e.code} (${e.syscall})`);
      return;
    }
    // Not ours — restore default fatal behaviour with the original error/stack.
    throw err;
  });

  process.on("unhandledRejection", (reason) => {
    if (isBenignIceSocketError(reason)) {
      const e = reason as NodeSystemError;
      log.debug(`[p2p] ignoring benign ICE socket rejection: ${e.code} (${e.syscall})`);
      return;
    }
    throw reason;
  });
}
