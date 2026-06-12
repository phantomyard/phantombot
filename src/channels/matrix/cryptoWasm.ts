/**
 * ============================================================================
 *  RUST-CRYPTO WASM EMBEDDING — THE SINGLE-BINARY SEAM (READ THIS FIRST)
 * ============================================================================
 *
 * phantombot ships as ONE `bun build --compile` ELF. matrix-js-sdk's E2EE
 * (the rust-crypto stack) is backed by a ~5.5 MB WebAssembly artifact from
 * `@matrix-org/matrix-sdk-crypto-wasm`. Getting that WASM to live INSIDE the
 * single binary — and actually instantiate at runtime — is the load-bearing
 * fact this whole channel rests on.
 *
 * THE BUG (and why the earlier "manual instantiation in this module" fix did
 * not hold):
 *
 *   matrix-js-sdk's `initRustCrypto()` ALWAYS calls the crypto package's own
 *   `initAsync()` (rust-crypto/index.js → `RustSdkCryptoJs.initAsync()`).
 *   Under the `matrix-org:wasm-esm` condition that resolves to the package's
 *   `index-wasm-esm.mjs`, whose `loadModuleAsync()` does:
 *
 *       const wasm = await import("./pkg/...wasm");   // (A)
 *       bindings.__wbg_set_wasm(wasm);                // (B)
 *       wasm.__wbindgen_start();                      // (C)
 *
 *   Under `bun --compile`, (A) does NOT return an instantiated WebAssembly
 *   namespace — it returns a module whose `default` is the embedded FILE PATH
 *   string. So (C) throws "wasm2.__wbindgen_start is not a function", and (B)
 *   has already CLOBBERED any good instance a pre-init shim had set. The
 *   bindings module IS shared (same resolved path everywhere) — so it was
 *   never a module-identity problem; the SDK's own loader simply overwrites a
 *   correct instance with a broken one and dies.
 *
 * THE FIX lives where the broken loader lives: a committed `bun patch` on
 * `@matrix-org/matrix-sdk-crypto-wasm` (see
 * `patches/@matrix-org%2Fmatrix-sdk-crypto-wasm@18.3.1.patch`, wired via
 * `patchedDependencies` in package.json) rewrites `loadModuleAsync` to embed
 * the bytes with `import wasm from "...wasm" with { type: "file" }`,
 * `readFileSync` them, and instantiate manually against the bindings module.
 * After the patch, the SDK's OWN `initAsync()` works in the compiled binary —
 * `initRustCrypto()` succeeds and a real `OlmMachine` loads. The patch
 * re-applies on every `bun install`, so the build pipeline carries it for
 * free; `bun build --compile --conditions matrix-org:wasm-esm` then statically
 * embeds the WASM via the patched `with { type: "file" }` import.
 *
 * Verify after any dependency bump with `phantombot matrix-cryptocheck`, which
 * instantiates a real OlmMachine through the production path inside the
 * compiled binary — the only test that actually exercises the WASM (unit tests
 * run interpreted, where (A) behaves and the bug is invisible).
 *
 * `ensureCryptoWasm()` now simply delegates to the package's (patched,
 * idempotent) `initAsync()`. It remains safe to call before EVERY client
 * `initRustCrypto()`: the package's internal `modPromise` gate makes repeat
 * calls a no-op, and because it is the SAME init the SDK runs, there is a
 * single instantiation and no clobbering. Imported only from the Matrix
 * transport / setup / notify paths, so a build with no Matrix channel still
 * embeds the WASM (static import) but never instantiates it.
 * ============================================================================
 */

// The package entry under the `matrix-org:wasm-esm` build condition — the SAME
// module matrix-js-sdk imports, so this is the one shared init path.
import { initAsync, Tracing, LoggerLevel } from "@matrix-org/matrix-sdk-crypto-wasm";
import { matrixDebugEnabled } from "./sdkLogging.ts";

// Keep the installed tracing layer referenced for the process lifetime so it is
// never freed out from under the WASM. Set once, on first `ensureCryptoWasm`.
let tracing: Tracing | undefined;

/**
 * Idempotently instantiate the rust-crypto WASM. Awaited before the first
 * `MatrixClient.initRustCrypto()`. Cheap to call repeatedly — the package's
 * `modPromise` gate makes everything after the first a no-op.
 *
 * Side effect: clamps the rust-crypto `tracing` layer to ERROR so the hundreds
 * of `INFO matrix_sdk_indexeddb::crypto_store::migrations …` lines the WASM
 * emits straight to console during store open/migration stay silent. Set
 * `PHANTOMBOT_MATRIX_DEBUG` to leave tracing at its verbose default.
 */
export async function ensureCryptoWasm(): Promise<void> {
  await initAsync();
  if (!tracing && !matrixDebugEnabled()) {
    try {
      // Installs/overrides the tracing layer at ERROR — suppresses the
      // INFO/DEBUG crypto-store migration firehose without touching warnings.
      tracing = new Tracing(LoggerLevel.Error);
    } catch {
      /* tracing control is best-effort; noisy logs are not worth failing on */
    }
  }
}
