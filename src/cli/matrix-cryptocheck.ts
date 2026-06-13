/**
 * `phantombot matrix-cryptocheck` — the native Rust-crypto smoke test.
 *
 * WHY THIS EXISTS: the unit suite cannot catch a single-binary crypto packaging
 * bug. Unit tests run interpreted (`bun test`), where the native addon resolves
 * from `node_modules` and crypto loads fine. The risk is only in a `bun
 * --compile` ELF (does the embedded `.node` resolve?). So "green tests" never
 * proved crypto worked in the shipped binary — this command does, by
 * instantiating a real `OlmMachine` through the production native-load path
 * INSIDE the compiled binary.
 *
 *     ./dist/phantombot matrix-cryptocheck            # native addon works (exit 0)
 *     ./dist/phantombot matrix-cryptocheck --persist  # + Rust SQLite store round-trip
 *
 * `--persist` additionally proves the on-disk crypto store: it forks TWO child
 * processes against a temp dir — one mints a crypto device into a Sqlite store,
 * the second re-opens that store in a FRESH process — and asserts both report
 * the SAME ed25519 device key. Separate processes = real proof the device
 * survives a restart (not a same-process cache hit). It touches no homeserver
 * and no real config.
 */

import { defineCommand } from "citty";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadNativeCrypto } from "../channels/matrix/nativeCrypto.ts";

/** Minimal shape of the bits of the native addon we touch here. */
interface NativeCrypto {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  OlmMachine: { initialize(...args: any[]): Promise<any> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  UserId: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  DeviceId: any;
  StoreType: { Sqlite: number };
}

/**
 * Instantiate a real `OlmMachine` through the SAME native loader the SDK uses
 * (in-memory store — no disk). Exercises the addon end to end; if the embedded
 * `.node` is missing/broken in a compiled binary it throws here.
 */
export async function runMatrixCryptoCheck(): Promise<number> {
  try {
    const rust = loadNativeCrypto() as NativeCrypto;
    const machine = await rust.OlmMachine.initialize(
      new rust.UserId("@cryptocheck:phantombot.local"),
      new rust.DeviceId("CRYPTOCHECK"),
    );
    const ed25519 = machine.identityKeys?.ed25519?.toBase64?.() ?? "?";
    process.stdout.write(
      `matrix-cryptocheck: OK — OlmMachine instantiated (ed25519 ${ed25519.slice(0, 16)}…)\n`,
    );
    return 0;
  } catch (e) {
    process.stderr.write(`matrix-cryptocheck: FAIL — ${(e as Error).message}\n`);
    return 1;
  }
}

/**
 * One phase of the persistence round-trip, run in a CHILD process so "restore"
 * gets a genuinely fresh process whose device can only come from the on-disk
 * Sqlite store. Prints `DEVICE=<ed25519>` on success. `generate` wipes +
 * creates; `restore` re-opens the same store dir.
 */
export async function runCryptoPersistPhase(
  phase: "generate" | "restore",
  dir: string,
): Promise<number> {
  try {
    const rust = loadNativeCrypto() as NativeCrypto;
    if (phase === "generate") rmSync(dir, { recursive: true, force: true });
    const machine = await rust.OlmMachine.initialize(
      new rust.UserId("@cryptocheck:phantombot.local"),
      new rust.DeviceId("CRYPTOCHECK"),
      dir,
      undefined,
      rust.StoreType.Sqlite,
    );
    const ed25519 = machine.identityKeys?.ed25519?.toBase64?.() ?? "?";
    process.stdout.write(`DEVICE=${ed25519}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`PERSIST-${phase}: FAIL — ${(e as Error).message}\n`);
    return 1;
  }
}

/** Orchestrate the two-process persistence round-trip and compare device keys. */
async function runPersistRoundTrip(): Promise<number> {
  const base = await runMatrixCryptoCheck();
  if (base !== 0) return base;

  const dir = mkdtempSync(join(tmpdir(), "phantom-cryptocheck-"));
  try {
    const runChild = (phase: string): string | null => {
      const r = spawnSync(
        process.execPath,
        ["matrix-cryptocheck", `--persist-phase=${phase}`, `--dir=${dir}`],
        {
          encoding: "utf8",
          // The Rust store migrations log verbosely; give generous headroom so
          // an ENOBUFS doesn't masquerade as a crypto failure.
          maxBuffer: 256 * 1024 * 1024,
        },
      );
      if (r.error) {
        process.stderr.write(
          `child ${phase} spawn error: ${(r.error as Error).message}\n`,
        );
        return null;
      }
      // The DEVICE= line is the source of truth, NOT the exit code: the prebuilt
      // Rust addon SIGABRTs during napi/tokio teardown on process exit (see
      // nativeCrypto.ts), so a child that did its job perfectly still exits
      // non-zero. stdout is already flushed before the abort, so parse it first
      // and only treat a MISSING device line as a real failure.
      const m = /DEVICE=(\S+)/.exec(r.stdout);
      if (m) return m[1]!;
      process.stderr.write(
        r.stderr || `child ${phase} produced no device (status ${r.status})\n`,
      );
      return null;
    };

    const gen = runChild("generate");
    const res = runChild("restore");
    if (!gen || !res) {
      process.stderr.write(
        "matrix-cryptocheck: FAIL — persistence phase errored\n",
      );
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
      "Smoke-test native Rust crypto: instantiate a real OlmMachine in the compiled binary; --persist also proves the on-disk Sqlite store round-trip (exit 0 = E2EE works).",
  },
  args: {
    persist: {
      type: "boolean",
      description:
        "Also verify the crypto store survives a restart (two-process Sqlite store round-trip).",
      default: false,
    },
    "persist-phase": {
      type: "string",
      description:
        "(internal) one phase of the persistence round-trip: generate | restore.",
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
