/**
 * `phantombot doctor` — sanity-check the install:
 *   - personas dir exists (or note that it doesn't yet)
 *   - default persona is importable
 *   - each harness in the chain has its binary on PATH and (best-effort)
 *     looks authenticated
 *
 * Returns 0 if every check passes, 1 if any failed.
 */

import { defineCommand } from "citty";
import { access, constants } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Config, loadConfig, personaDir } from "../config.ts";
import type { WriteSink } from "../lib/io.ts";

export interface RunDoctorInput {
  config?: Config;
  out?: WriteSink;
  /** Override binary lookup for testing. */
  which?: (bin: string) => Promise<string | undefined>;
}

interface CheckResult {
  label: string;
  ok: boolean;
  detail: string;
}

export async function runDoctor(input: RunDoctorInput = {}): Promise<number> {
  const out = input.out ?? process.stdout;
  const config = input.config ?? (await loadConfig());
  const which = input.which ?? defaultWhich;

  const checks: CheckResult[] = [];

  // Personas dir
  checks.push({
    label: "personas dir",
    ok: existsSync(config.personasDir),
    detail: existsSync(config.personasDir)
      ? config.personasDir
      : `${config.personasDir} (run import-persona to create)`,
  });

  // Default persona
  const defaultDir = personaDir(config, config.defaultPersona);
  checks.push({
    label: `default persona '${config.defaultPersona}'`,
    ok: existsSync(defaultDir),
    detail: existsSync(defaultDir)
      ? defaultDir
      : `${defaultDir} (not imported yet)`,
  });

  // Each harness
  for (const id of config.harnesses.chain) {
    if (id === "claude") {
      checks.push(...(await checkClaude(config, which)));
    } else if (id === "pi") {
      checks.push(...(await checkPi(config, which)));
    } else {
      checks.push({
        label: `harness '${id}'`,
        ok: false,
        detail: "unknown harness id",
      });
    }
  }

  for (const c of checks) {
    out.write(`  [${c.ok ? "ok  " : "FAIL"}] ${c.label}: ${c.detail}\n`);
  }

  const failed = checks.filter((c) => !c.ok).length;
  out.write(
    `\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}\n`,
  );
  return failed === 0 ? 0 : 1;
}

async function checkClaude(
  config: Config,
  which: (bin: string) => Promise<string | undefined>,
): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const binPath = await which(config.harnesses.claude.bin);
  out.push({
    label: "claude binary",
    ok: binPath !== undefined,
    detail: binPath ?? `${config.harnesses.claude.bin} (not on PATH)`,
  });

  // OAuth credentials live at ~/.claude/.credentials.json. Either that or
  // ANTHROPIC_API_KEY env var means claude can authenticate.
  const credPath = join(homedir(), ".claude", ".credentials.json");
  const hasCreds = existsSync(credPath);
  const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
  out.push({
    label: "claude auth",
    ok: hasCreds || hasApiKey,
    detail: hasCreds
      ? `OAuth credentials at ${credPath}`
      : hasApiKey
        ? "ANTHROPIC_API_KEY env var set"
        : `no credentials (run \`claude /login\` or set ANTHROPIC_API_KEY)`,
  });
  return out;
}

async function checkPi(
  config: Config,
  which: (bin: string) => Promise<string | undefined>,
): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const binPath = await which(config.harnesses.pi.bin);
  out.push({
    label: "pi binary",
    ok: binPath !== undefined,
    detail: binPath ?? `${config.harnesses.pi.bin} (not on PATH)`,
  });
  // Pi's auth model is verified end-to-end by phase 9 tests; doctor just
  // confirms the binary is reachable. A failed invocation will surface a
  // clear error at run time.
  return out;
}

async function defaultWhich(bin: string): Promise<string | undefined> {
  if (bin.startsWith("/")) {
    try {
      await access(bin, constants.X_OK);
      return bin;
    } catch {
      return undefined;
    }
  }
  // Walk PATH manually — works in compiled binaries where shell isn't around.
  const path = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of path.split(sep)) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

export default defineCommand({
  meta: {
    name: "doctor",
    description:
      "Check that configured harness binaries (claude, pi) are on PATH and authenticated.",
  },
  async run() {
    const code = await runDoctor();
    process.exitCode = code;
  },
});
