/**
 * `phantombot fix-signing` — stop macOS from endlessly re-prompting for home /
 * Documents / Full Disk Access after every auto-update.
 *
 * WHY. macOS TCC pins each permission grant to the binary's code-signing
 * identity. phantombot ships ad-hoc signed and rewrites its own binary on every
 * update, so the identity changes every time and macOS re-asks forever. This
 * command installs a STABLE self-signed signing identity (in a dedicated
 * throwaway keychain, never the login keychain) and signs the current binary
 * with it, so a single Full Disk Access grant sticks across all future updates.
 * See src/lib/macSigning.ts for the safety model (transactional, headless,
 * rollback-on-failure).
 *
 * NOT AN OPT-IN. `phantombot update` already applies this identity
 * automatically on every macOS update, so most users never need this command.
 * It exists as a MANUAL trigger: apply the identity to the current binary right
 * now (without waiting for the next update), or repair it if an update's
 * automatic re-sign failed and left an ad-hoc signature behind. It calls the
 * same idempotent, transactional `fixSigning` the update path uses.
 *
 * NON-macOS. On Linux/Windows this is a friendly no-op (exit 0): there is no
 * TCC and nothing to fix.
 */

import { defineCommand } from "citty";

import { isPhantombotBinary } from "../lib/binaryIdentity.ts";
import { BunCommandRunner, fixSigning } from "../lib/macSigning.ts";
import type { WriteSink } from "../lib/io.ts";
import { openPersonaVault } from "../lib/vault.ts";
import { resolveVaultPersonaDir } from "./vault.ts";

export interface RunFixSigningInput {
  /** Defaults to process.platform. Tests override. */
  procPlatform?: string;
  /** Defaults to process.execPath. Tests override. */
  binPath?: string;
  persona?: string;
  out?: WriteSink;
  err?: WriteSink;
  /**
   * Test seam — inject the whole signing step. In production this is undefined
   * and runFixSigning wires the real vault + BunCommandRunner.
   */
  applySigning?: (binPath: string) => Promise<{ ok: boolean; message: string }>;
}

export async function runFixSigning(
  input: RunFixSigningInput = {},
): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const procPlatform = input.procPlatform ?? process.platform;

  if (procPlatform !== "darwin") {
    out.write(
      "fix-signing is macOS-only — there's no TCC permission nagging to fix " +
        "on this platform. Nothing to do.\n",
    );
    return 0;
  }

  const binPath = input.binPath ?? process.execPath;
  if (!isPhantombotBinary(binPath)) {
    err.write(
      "fix-signing must run against the installed phantombot binary, not " +
        "'bun src/index.ts'. Install a release binary first.\n",
    );
    return 1;
  }

  const apply =
    input.applySigning ??
    (async (bp: string) => {
      const dir = await resolveVaultPersonaDir(input.persona);
      const vault = await openPersonaVault(dir);
      try {
        return await fixSigning({
          runner: new BunCommandRunner(),
          vault,
          binPath: bp,
        });
      } finally {
        vault.close();
      }
    });

  out.write("Setting up a stable code-signing identity for phantombot…\n");
  const result = await apply(binPath);
  if (result.ok) {
    out.write(`✅ ${result.message}\n`);
    return 0;
  }
  err.write(
    `⚠️  ${result.message}\n` +
      `Nothing was broken — you can retry with 'phantombot fix-signing'. If it ` +
      `keeps failing, the fallback is Full Disk Access in System Settings → ` +
      `Privacy & Security (you'll just be re-prompted after each update).\n`,
  );
  return 1;
}

export default defineCommand({
  meta: {
    name: "fix-signing",
    description:
      "macOS: install a stable code-signing identity so TCC stops re-prompting for permissions after every update.",
  },
  async run() {
    process.exitCode = await runFixSigning();
  },
});
