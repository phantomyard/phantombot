/**
 * Doctor's native-key audit must never provision a persona it only inspected.
 *
 * Regression (PR #550 review): the audit called copyNativeKeys with only a
 * personaDir, so the default opener (openPersonaVault →
 * getOrCreatePersonaIdentity) minted identity.json + vault.sqlite for any
 * persona with a native slot and no identity — even on a plain, non-repair
 * `phantombot doctor`. The runDoctor-level invariant test could not see it:
 * its fixture had no native slots and this path sits behind
 * isPhantombotBinary(), so this test calls the real report function directly.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeHarnessConfigReport } from "../src/cli/doctor.ts";
import { loadConfigForPersona } from "../src/config.ts";

const KEYS = [
  "PHANTOMBOT_CONFIG",
  "PHANTOMBOT_PERSONAS_DIR",
  "XDG_DATA_HOME",
  "HOME",
  "PHANTOMBOT_PI_PROVIDER",
  "PHANTOMBOT_PRIMARY_MODEL",
  "PHANTOMBOT_IMAGE_MODEL",
  "PHANTOMBOT_CODING_MODEL",
  "PHANTOMBOT_PI_API_KEY",
  "PHANTOMBOT_PI_API_KEY_PI_PRIMARY",
  "OPENROUTER_API_KEY",
] as const;
const SAVED = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let work = "";

afterEach(() => {
  for (const k of KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  if (work) rmSync(work, { recursive: true, force: true });
  work = "";
});

describe("doctor native-key audit", () => {
  test("a non-repair run never mints an identity or vault", async () => {
    for (const k of KEYS) delete process.env[k];
    work = mkdtempSync(join(tmpdir(), "doctor-native-audit-"));
    const personasDir = join(work, "personas");
    const dir = join(personasDir, "alice");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(work, "config.toml"),
      `default_persona = "alice"
[harnesses]
chain = ["pi-primary"]
[harnesses.instances.pi-primary]
type = "native"
[harnesses.instances.pi-primary.routing]
provider = "phantombot-test-no-such-provider"
primary_model = "openai/gpt-5"
`,
    );
    process.env.PHANTOMBOT_CONFIG = join(work, "config.toml");
    process.env.PHANTOMBOT_PERSONAS_DIR = personasDir;
    process.env.XDG_DATA_HOME = join(work, "data");
    // homedir() ignores HOME under bun, so the real ~/.pi/agent/auth.json is
    // read: the fixture uses a provider no auth store can hold a key for.

    const { config } = await loadConfigForPersona("alice");
    const report = await computeHarnessConfigReport(config, config, "alice", false);

    // The audit still ran and reported the slot it could not resolve (once for
    // the host chain, once for the persona that serves it)…
    const keys = report?.nativeKeys ?? [];
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.id === "pi-primary" && !k.resolved)).toBe(true);
    // …without provisioning anything.
    expect(existsSync(join(dir, "identity.json"))).toBe(false);
    expect(existsSync(join(dir, "vault.sqlite"))).toBe(false);
  });
});
