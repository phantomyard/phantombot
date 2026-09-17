/**
 * Image support for the embedded pi engine: serve photon's WASM from INSIDE
 * the binary.
 *
 * Pi resizes every inbound image with Photon (`@silvia-odwyer/photon-node`),
 * whose CJS entry does `fs.readFileSync(__dirname + "/photon_rs_bg.wasm")`.
 * In a `bun build --compile` binary `__dirname` is the BUILD machine's
 * node_modules path (for a release, `/home/runner/work/...`), which never
 * exists on a user's host. Pi's own fallback then looks beside the executable
 * and in the cwd — pi's release ships the file there, phantombot's does not.
 * When every lookup misses, pi's `loadPhoton()` swallows the error and each
 * image becomes "[Image omitted: could not be resized below the inline image
 * size limit.]", whatever its size. Native-harness vision was silently dead
 * on every host.
 *
 * The fix embeds the WASM as a bun file asset and redirects reads of
 * `photon_rs_bg.wasm` to it. The embedded copy wins even when a file exists at
 * the looked-up path: it is the exact photon build this binary was compiled
 * and tested against, so a stray file on disk can never change behaviour.
 *
 * Only installed in the compiled `__pi` process. From source, photon resolves
 * its real node_modules path and needs no help.
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
// The `with { type: "file" }` import makes bun embed the bytes in the compiled
// binary and hand back a path it can read them from ($bunfs / ~BUN).
import embeddedWasmPath from "../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm" with { type: "file" };

export const PHOTON_WASM_FILENAME = "photon_rs_bg.wasm";

/** Path the embedded photon WASM is readable from in this process. */
export const EMBEDDED_PHOTON_WASM_PATH: string = embeddedWasmPath;

type ReadFileSync = (...args: unknown[]) => unknown;

function pathOf(file: unknown): string | undefined {
  if (typeof file === "string") return file;
  if (file instanceof URL && file.protocol === "file:") return fileURLToPath(file);
  return undefined;
}

/** Does this readFileSync target photon's WASM (any directory, / or \)? */
export function isPhotonWasmPath(file: unknown): boolean {
  const p = pathOf(file);
  return p !== undefined && /(^|[\\/])photon_rs_bg\.wasm$/.test(p);
}

let installed = false;

/**
 * Redirect every `fs.readFileSync` of photon's WASM to the embedded copy.
 * Idempotent. Patches the CommonJS `fs` object, which is the one photon's
 * `require('fs')` and pi's own wrapper both read — and pi's wrapper binds
 * whatever readFileSync is current when it runs, so it chains through this.
 */
export function installEmbeddedPhotonWasm(
  wasmPath: string = EMBEDDED_PHOTON_WASM_PATH,
): void {
  if (installed) return;
  const fs = createRequire(import.meta.url)("node:fs") as {
    readFileSync: ReadFileSync;
  };
  const original = fs.readFileSync.bind(fs) as ReadFileSync;
  fs.readFileSync = ((...args: unknown[]) => {
    if (isPhotonWasmPath(args[0])) {
      return original(wasmPath, ...args.slice(1));
    }
    return original(...args);
  }) as ReadFileSync;
  installed = true;
}
