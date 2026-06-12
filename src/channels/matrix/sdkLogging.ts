/**
 * Quieting matrix-js-sdk + rust-crypto's log firehose.
 *
 * Out of the box, a single `phantombot chat matrix` run (or a runtime connect)
 * spews HUNDREDS of lines from two independent sources:
 *
 *   1. matrix-js-sdk's OWN logger (loglevel-based) — every `FetchHttpApi -->`,
 *      `sync …`, `[Perf]`, `Adding default global … push rule`, `Init
 *      OlmMachine`, `Downloading Rust crypto library`, etc. These flow through
 *      the `logger` you hand to `createClient`. Pass a quiet one and they stop.
 *   2. The rust-crypto WASM's `tracing` layer — every `INFO
 *      matrix_sdk_indexeddb::crypto_store::migrations …`. These are emitted by
 *      the WASM directly to console and are NOT routed through the JS logger;
 *      they're governed by the `Tracing` min-level (see cryptoWasm.ts).
 *
 * This module owns (1): a `Logger` that drops trace/debug/info and forwards
 * only warn/error into our own structured logger. (2) is handled in
 * cryptoWasm.ts. Both honour `PHANTOMBOT_MATRIX_DEBUG` — set it to keep the
 * full verbose firehose when actually debugging the SDK.
 */

import { log } from "../../lib/logger.ts";

/**
 * True when the operator opted into the full SDK/crypto firehose via
 * `PHANTOMBOT_MATRIX_DEBUG`. When set we hand back the SDK's default verbose
 * logger and leave rust tracing at its default level — nothing is suppressed.
 */
export function matrixDebugEnabled(): boolean {
  const v = process.env.PHANTOMBOT_MATRIX_DEBUG;
  return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

/**
 * The minimal `Logger` shape matrix-js-sdk wants for `createClient({ logger })`:
 * trace/debug/info/warn/error plus `getChild`. We model it structurally so we
 * never import the SDK's type graph here.
 */
export interface MatrixSdkLogger {
  trace(...msg: unknown[]): void;
  debug(...msg: unknown[]): void;
  info(...msg: unknown[]): void;
  warn(...msg: unknown[]): void;
  error(...msg: unknown[]): void;
  getChild(namespace: string): MatrixSdkLogger;
}

const noop = (): void => {};

/**
 * Build a quiet matrix-js-sdk logger. trace/debug/info are dropped; warn/error
 * are forwarded into our structured logger (prefixed so they're attributable).
 * `getChild` returns the same quiet logger — child namespaces inherit silence.
 *
 * Returns `undefined` when `PHANTOMBOT_MATRIX_DEBUG` is set, so the caller hands
 * `createClient` no `logger` and gets the SDK's default verbose behaviour.
 */
export function quietMatrixLogger(): MatrixSdkLogger | undefined {
  if (matrixDebugEnabled()) return undefined;
  const logger: MatrixSdkLogger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: (...msg: unknown[]) => log.warn("matrix-sdk", { msg: stringify(msg) }),
    error: (...msg: unknown[]) => log.error("matrix-sdk", { msg: stringify(msg) }),
    getChild: () => logger,
  };
  return logger;
}

/** Flatten the SDK's variadic log args into a single string for our logger. */
function stringify(msg: unknown[]): string {
  return msg
    .map((m) =>
      m instanceof Error
        ? m.message
        : typeof m === "string"
          ? m
          : safeJson(m),
    )
    .join(" ");
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
