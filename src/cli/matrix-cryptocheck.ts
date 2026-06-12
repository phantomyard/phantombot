/**
 * `phantombot matrix-cryptocheck` — the rust-crypto WASM + persistence smoke test.
 *
 * WHY THIS EXISTS: the unit suite cannot catch the single-binary WASM bug. Unit
 * tests run interpreted (`bun test`), where `await import("...wasm")` returns a
 * real instance and the crypto bootstraps fine. The failure only manifests in a
 * `bun --compile` ELF (see channels/matrix/cryptoWasm.ts). So "green tests"
 * never proved crypto worked — this command does, by instantiating a real
 * `OlmMachine` through the production init path INSIDE the compiled binary.
 *
 *     ./dist/phantombot matrix-cryptocheck            # WASM works (exit 0)
 *     ./dist/phantombot matrix-cryptocheck --persist  # WASM + disk round-trip
 *
 * `--persist` additionally proves the fake-indexeddb → disk snapshot layer
 * (see channels/matrix/idbPersist.ts): it forks TWO child processes against a
 * temp dir — one mints a crypto device + snapshots it, the second restores from
 * that snapshot in a FRESH process — and asserts both report the SAME device
 * key. Separate processes = real proof the device survives a restart (not a
 * same-process cache hit). It touches no homeserver and no real config.
 */

import { defineCommand } from "citty";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/**
 * One phase of the persistence round-trip, run in a CHILD process so "restore"
 * gets a genuinely empty in-memory store that can only be filled from disk.
 * Prints `DEVICE=<ed25519>` on success. `generate` wipes + creates; `restore`
 * reads back the snapshot.
 */
export async function runCryptoPersistPhase(
  phase: "generate" | "restore",
  dir: string,
): Promise<number> {
  try {
    const { installPersistentIndexedDB, cryptoSnapshotPath, MATRIX_CRYPTO_DB_PREFIX, flushSnapshot } =
      await import("../channels/matrix/idbPersist.ts");
    const { ensureCryptoWasm } = await import(
      "../channels/matrix/cryptoWasm.ts"
    );
    if (phase === "generate") rmSync(dir, { recursive: true, force: true });

    await installPersistentIndexedDB(cryptoSnapshotPath(dir));
    await ensureCryptoWasm();
    const sdk = await import("matrix-js-sdk");
    const { quietMatrixLogger } = await import(
      "../channels/matrix/sdkLogging.ts"
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = sdk.createClient({
      // Unroutable base URL: initRustCrypto does a best-effort key-backup probe
      // we don't care about; the device keys are generated/read locally.
      baseUrl: "https://localhost:1",
      userId: "@cryptocheck:phantombot.local",
      deviceId: "CRYPTOCHECK",
      accessToken: "syt_cryptocheck_offline",
      // Keep the gate's output to its own OK/FAIL lines (undefined under
      // PHANTOMBOT_MATRIX_DEBUG).
      logger: quietMatrixLogger(),
    });
    await client.initRustCrypto({ cryptoDatabasePrefix: MATRIX_CRYPTO_DB_PREFIX });
    const keys = await client.getCrypto().getOwnDeviceKeys();
    if (phase === "generate") {
      // Let the store settle, then force the snapshot to disk.
      await new Promise((r) => setTimeout(r, 500));
      await flushSnapshot();
    }
    process.stdout.write(`DEVICE=${keys.ed25519}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`PERSIST-${phase}: FAIL — ${(e as Error).message}\n`);
    return 1;
  }
}

/** Orchestrate the two-process persistence round-trip and compare device keys. */
async function runPersistRoundTrip(): Promise<number> {
  const wasm = await runMatrixCryptoCheck();
  if (wasm !== 0) return wasm;

  const dir = mkdtempSync(join(tmpdir(), "phantom-cryptocheck-"));
  try {
    const runChild = (phase: string): string | null => {
      const r = spawnSync(
        process.execPath,
        ["matrix-cryptocheck", `--persist-phase=${phase}`, `--dir=${dir}`],
        {
          encoding: "utf8",
          // The rust-crypto migrations log verbosely to stderr; the default
          // 1MB maxBuffer overflows, killing the child with status=null and
          // error=ENOBUFS — which surfaced as the opaque "exited undefined".
          // Give it generous headroom so the round-trip isn't a false failure.
          maxBuffer: 256 * 1024 * 1024,
        },
      );
      if (r.error) {
        process.stderr.write(
          `child ${phase} spawn error: ${(r.error as Error).message}\n`,
        );
        return null;
      }
      if (r.status !== 0) {
        process.stderr.write(
          r.stderr || `child ${phase} exited with status ${r.status}\n`,
        );
        return null;
      }
      const m = /DEVICE=(\S+)/.exec(r.stdout);
      return m ? m[1]! : null;
    };

    const gen = runChild("generate");
    const res = runChild("restore");
    if (!gen || !res) {
      process.stderr.write("matrix-cryptocheck: FAIL — persistence phase errored\n");
      return 1;
    }
    if (gen !== res) {
      process.stderr.write(
        `matrix-cryptocheck: FAIL — device not stable across restart (generate=${gen} restore=${res})\n`,
      );
      return 1;
    }
    process.stdout.write(
      `matrix-cryptocheck: OK — crypto store persists to disk (stable device ${gen.slice(0, 16)}…)\n`,
    );
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export default defineCommand({
  meta: {
    name: "matrix-cryptocheck",
    description:
      "Smoke-test rust-crypto: instantiate a real OlmMachine in the compiled binary; --persist also proves the disk snapshot round-trip (exit 0 = E2EE works).",
  },
  args: {
    persist: {
      type: "boolean",
      description:
        "Also verify the crypto store survives a restart (two-process disk snapshot round-trip).",
      default: false,
    },
    "persist-phase": {
      type: "string",
      description: "(internal) one phase of the persistence round-trip: generate | restore.",
    },
    dir: {
      type: "string",
      description: "(internal) temp dir for the persistence round-trip.",
    },
  },
  async run({ args }) {
    const phase = args["persist-phase"] as string | undefined;
    if (phase === "generate" || phase === "restore") {
      process.exitCode = await runCryptoPersistPhase(phase, args.dir as string);
      return;
    }
    process.exitCode = args.persist
      ? await runPersistRoundTrip()
      : await runMatrixCryptoCheck();
  },
});
