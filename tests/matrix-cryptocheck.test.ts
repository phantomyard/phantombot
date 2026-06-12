/**
 * Smoke test for `phantombot matrix-cryptocheck`. NOTE: under `bun test`
 * (interpreted) the WASM loads via the normal path, so this guards the command
 * wiring + that a real OlmMachine instantiates here. The compile-mode bug it
 * exists to catch only manifests in the `bun --compile` ELF — run the command
 * against dist/phantombot for that gate.
 */
import { test, expect } from "bun:test";
import { runMatrixCryptoCheck } from "../src/cli/matrix-cryptocheck.ts";

test("matrix-cryptocheck instantiates a real OlmMachine (interpreted)", async () => {
  const code = await runMatrixCryptoCheck();
  expect(code).toBe(0);
});
