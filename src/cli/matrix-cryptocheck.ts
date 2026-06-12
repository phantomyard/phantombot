/**
 * `phantombot matrix-cryptocheck` — the rust-crypto WASM smoke test.
 *
 * WHY THIS EXISTS: the unit suite cannot catch the single-binary WASM bug. Unit
 * tests run interpreted (`bun test`), where `await import("...wasm")` returns a
 * real instance and the crypto bootstraps fine. The failure only manifests in a
 * `bun --compile` ELF (see channels/matrix/cryptoWasm.ts). So "green tests"
 * never proved crypto worked — this command does, by instantiating a real
 * `OlmMachine` through the production init path INSIDE the compiled binary.
 *
 * Run it against any freshly built binary (and after dependency bumps) as the
 * real "green means green" gate:
 *
 *     ./dist/phantombot matrix-cryptocheck    # exits 0 = WASM E2EE works
 *
 * It touches no config, no homeserver, no network — just the crypto core.
 */

import { defineCommand } from "citty";

export async function runMatrixCryptoCheck(): Promise<number> {
  try {
    const { ensureCryptoWasm } = await import(
      "../channels/matrix/cryptoWasm.ts"
    );
    await ensureCryptoWasm();

    // Instantiate a real OlmMachine through the SAME bindings the SDK uses.
    // This exercises wasm malloc + the rust-crypto entry points end to end; if
    // the WASM instance is missing/broken it throws here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rust: any = await import("@matrix-org/matrix-sdk-crypto-wasm");
    const machine = await rust.OlmMachine.initialize(
      new rust.UserId("@cryptocheck:phantombot.local"),
      new rust.DeviceId("CRYPTOCHECK"),
    );
    const deviceId = machine.deviceId?.toString?.() ?? "?";
    // Best-effort free if the binding exposes it.
    try {
      machine.free?.();
    } catch {
      /* ignore */
    }

    process.stdout.write(
      `matrix-cryptocheck: OK — OlmMachine instantiated (device ${deviceId})\n`,
    );
    return 0;
  } catch (e) {
    process.stderr.write(
      `matrix-cryptocheck: FAIL — ${(e as Error).message}\n`,
    );
    return 1;
  }
}

export default defineCommand({
  meta: {
    name: "matrix-cryptocheck",
    description:
      "Smoke-test rust-crypto WASM: instantiate a real OlmMachine in the compiled binary (exit 0 = E2EE works).",
  },
  async run() {
    process.exitCode = await runMatrixCryptoCheck();
  },
});
