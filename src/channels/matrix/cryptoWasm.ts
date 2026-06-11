/**
 * ============================================================================
 *  RUST-CRYPTO WASM EMBEDDING — THE SINGLE-BINARY SEAM (READ THIS FIRST)
 * ============================================================================
 *
 * phantombot ships as ONE `bun build --compile` ELF. matrix-js-sdk's E2EE
 * (the rust-crypto stack) is backed by a ~5.5 MB WebAssembly artifact from
 * `@matrix-org/matrix-sdk-crypto-wasm`. Getting that WASM to live INSIDE the
 * single binary — and actually instantiate at runtime — is the load-bearing
 * fact this whole channel rests on, so it gets its own module + a long
 * comment.
 *
 * Why this isn't automatic:
 *
 *   1. The crypto package's DEFAULT node entry (`node.mjs`) loads the WASM via
 *      `fs.readFileSync(fileURLToPath(new URL("./pkg/...wasm", import.meta.url)))`.
 *      Under `bun --compile` that path points into `$bunfs` but the WASM was
 *      never embedded (Bun only embeds assets it sees STATICALLY imported), so
 *      it ENOENTs at runtime — the exact failure flagged as the first risk in
 *      the spec.
 *
 *   2. The package ALSO ships an ESM-integration entry (`index-wasm-esm.mjs`),
 *      selected by the `matrix-org:wasm-esm` resolve CONDITION. It does
 *      `await import("./pkg/...wasm")`, which Bun CAN statically embed. The
 *      build is wired with `--conditions matrix-org:wasm-esm` (package.json
 *      build:x64 / build:arm64) so that resolution wins.
 *
 *      BUT: under `bun --compile`, `await import("x.wasm")` does NOT return an
 *      instantiated WebAssembly namespace — it returns a module whose `default`
 *      is the embedded FILE PATH string. So `index-wasm-esm.mjs`'s
 *      `wasm.__wbindgen_start()` throws "__wbindgen_start is not a function"
 *      because there's no instance to start. i.e. the upstream ESM loader is
 *      incompatible with Bun's compiled-asset model.
 *
 * The fix (proven to load a real `OlmMachine` in the compiled binary):
 *
 *   - Embed the WASM ourselves with `import wasmPath from "...wasm" with
 *     { type: "file" }`. Under `bun --compile` Bun copies the bytes into
 *     `$bunfs` and hands us a readable path; under plain `bun run` / Node it's
 *     the on-disk path. Either way `readFileSync(wasmPath)` yields the bytes.
 *   - Instantiate the module MANUALLY against the generated bindings
 *     (`pkg/matrix_sdk_crypto_wasm_bg.js`), then call `__wbg_set_wasm(exports)`
 *     and `exports.__wbindgen_start()`.
 *   - Because `__wbg_set_wasm` and the JS class wrappers (`OlmMachine`, …) are
 *     re-exported from the SAME bindings module the SDK imports under the
 *     wasm-esm condition, the instance we set IS the instance the SDK uses.
 *
 * The deep `node_modules/...` relative imports are deliberate: those `pkg/`
 * files are not exposed as package export subpaths, so we reach them by path.
 * They are stable parts of the published artifact.
 *
 * `ensureCryptoWasm()` is idempotent and safe to call before EVERY client
 * `initRustCrypto()`. The SDK's own `RustSdkCryptoJs.initAsync()` (invoked
 * deep inside `initRustCrypto`) is also idempotent and becomes a near no-op
 * once our instance is set, so the two coexist.
 *
 * This module is imported only from the Matrix transport, so a phantombot
 * build with no Matrix channel configured still embeds the WASM (it's a
 * static import) — that's fine; it's inert until crypto is initialised.
 * ============================================================================
 */

import { readFileSync } from "node:fs";

// Embed the WASM bytes as a file asset. `with { type: "file" }` makes Bun
// copy the artifact into the compiled binary's $bunfs and resolve `wasmPath`
// to a readable path at runtime (and to the on-disk path under `bun run`).
// @ts-expect-error — Bun's "file" import attribute yields a string path; TS
// has no type for it. This is the embedding hook; see the file header.
import wasmPath from "../../../node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg/matrix_sdk_crypto_wasm_bg.wasm" with { type: "file" };
// The generated wasm-bindgen JS glue. `__wbg_set_wasm` installs the live WASM
// instance the SDK's class wrappers call into. We import the SAME module the
// SDK resolves under the wasm-esm condition so the instance is shared.
// @ts-expect-error — deep internal path, no bundled types; treated as the
// wasm-bindgen import object + the __wbg_set_wasm setter.
import * as bindings from "../../../node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg/matrix_sdk_crypto_wasm_bg.js";

let initialised = false;

/**
 * Idempotently instantiate the rust-crypto WASM and wire it into the SDK's
 * bindings. Must be awaited before the first `MatrixClient.initRustCrypto()`.
 * Cheap to call repeatedly — after the first success it's a flag check.
 */
export async function ensureCryptoWasm(): Promise<void> {
  if (initialised) return;
  const bytes = readFileSync(wasmPath as unknown as string);
  const mod = new WebAssembly.Module(bytes);
  // The bindings module is the wasm's import object under the key the
  // generated glue expects ("./matrix_sdk_crypto_wasm_bg.js").
  // The import object maps the glue module name → the JS bindings. Cast
  // through `any`: the bindings module is wasm-bindgen glue, not a typed
  // WebAssembly import record, and the exact WebAssembly.Imports shape differs
  // between the Bun and DOM lib typings.
  const importObject = {
    "./matrix_sdk_crypto_wasm_bg.js": bindings,
  } as unknown as Bun.WebAssembly.Imports;
  const instance = new WebAssembly.Instance(mod, importObject);
  const exports = instance.exports as Record<string, unknown> & {
    __wbindgen_start: () => void;
  };
  // Install the live instance into the JS glue, then run wasm-bindgen's start
  // hook (sets up the heap / function table). Order matters: set first so the
  // start hook's calls resolve against the instance.
  (bindings as { __wbg_set_wasm: (w: unknown) => void }).__wbg_set_wasm(exports);
  exports.__wbindgen_start();
  initialised = true;
}
