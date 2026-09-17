/**
 * Which phantom a launch opens, against a real host on disk (issue #575).
 *
 * REGRESSION test for the review of #576: the entrypoint resolved the vault it
 * decrypts from the full chain (`--persona` → `PHANTOMBOT_PERSONA` → configured
 * default) while the TUI resolved the opening screen from the FLAG ALONE. With
 * `PHANTOMBOT_PERSONA=lena` and the default `robbie`, `phantombot --prompt "…"`
 * therefore decrypted Lena's vault and sent the trusted seed to Robbie's chat:
 * the wrong phantom, holding another phantom's secrets.
 *
 * `launchOpeningTarget` is the single resolver both sides now use, so this
 * drives it into the REAL `resolveOpeningScreen` with real personas on disk —
 * "the chain was parsed" and "the chat that opens belongs to that phantom" are
 * different claims, and only the second one is the fix.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveLaunchPersona } from "../src/lib/tuiGate.ts";
import { resolveLaunchOpening, startTui } from "../src/tui/index.tsx";
import { loadConfig } from "../src/config.ts";
import { hostSnapshot } from "../src/tui/snapshot.ts";

const ENV_KEYS = [
  "PHANTOMBOT_CONFIG",
  "PHANTOMBOT_PERSONAS_DIR",
  "PHANTOMBOT_STATE",
  "PHANTOMBOT_STATE_AUDIT",
  "PHANTOMBOT_DEFAULT_PERSONA",
  "PHANTOMBOT_PERSONA",
] as const;

let workdir: string;
let personasDir: string;
const saved: Record<string, string | undefined> = {};

async function makePersona(name: string): Promise<void> {
  const dir = join(personasDir, name);
  await mkdir(dir, { recursive: true });
  // identity.json is the wizard-fixable gate: without it the resolver routes
  // to the wizard for completeness, hiding which persona it picked.
  await writeFile(join(dir, "identity.json"), "{}", "utf8");
}

/**
 * The REAL launch decision path — `startTui`'s own pre-render half, not a
 * re-implementation of it. Re-deriving the chain in the test is what let the
 * first cut of this fix pass while `startTui` still read `launch.persona`.
 */
async function openingFor(launch: {
  persona?: string;
  prompt?: string;
}): Promise<{ persona?: string; screen?: string; refusal?: string }> {
  const launched = await resolveLaunchOpening(launch, await hostSnapshot());
  if ("refusal" in launched) return { refusal: launched.refusal };
  return { persona: launched.opening.persona, screen: launched.opening.screen };
}

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-launch-persona-"));
  personasDir = join(workdir, "personas");
  await mkdir(personasDir, { recursive: true });
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.PHANTOMBOT_CONFIG = join(workdir, "config.toml");
  process.env.PHANTOMBOT_PERSONAS_DIR = personasDir;
  process.env.PHANTOMBOT_STATE = join(workdir, "state.json");
  process.env.PHANTOMBOT_STATE_AUDIT = join(workdir, "state-audit.log");
  delete process.env.PHANTOMBOT_DEFAULT_PERSONA;
  delete process.env.PHANTOMBOT_PERSONA;
  await makePersona("robbie");
  await makePersona("lena");
  await writeFile(
    process.env.PHANTOMBOT_CONFIG,
    'default_persona = "robbie"\n',
    "utf8",
  );
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  await rm(workdir, { recursive: true, force: true });
});

describe("a launch opens the phantom whose vault it decrypted", () => {
  test("PHANTOMBOT_PERSONA differs from the default: the ENV phantom opens", async () => {
    process.env.PHANTOMBOT_PERSONA = "lena";

    const opening = await openingFor({ prompt: "who are you?" });

    expect(opening.refusal).toBeUndefined();
    expect(opening.persona).toBe("lena");
    // The entrypoint bootstraps the vault from the same resolver, so the
    // secrets in the chat's env belong to the phantom that just opened.
    const config = await loadConfig();
    expect(
      resolveLaunchPersona({ prompt: "who are you?" }, process.env, config.defaultPersona)
        .name,
    ).toBe("lena");
  });

  test("--persona beats the env var", async () => {
    process.env.PHANTOMBOT_PERSONA = "lena";

    const opening = await openingFor({ persona: "robbie", prompt: "hi" });

    expect(opening.persona).toBe("robbie");
  });

  test("nothing set: the configured default opens, as it always did", async () => {
    const opening = await openingFor({ prompt: "hi" });

    expect(opening.persona).toBe("robbie");
  });

  test("an env var naming a phantom that does not exist is refused, not silently swapped", async () => {
    process.env.PHANTOMBOT_PERSONA = "ghost";

    const opening = await openingFor({ prompt: "hi" });

    expect(opening.refusal).toContain("PHANTOMBOT_PERSONA");
    expect(opening.refusal).toContain("ghost");
  });

  test("the refusal is what the real startTui does: exit 2, one line, no screen", async () => {
    // `startTui` itself, not just its decision half. It returns BEFORE the
    // full-screen renderer, so a refused launch never takes the terminal.
    process.env.PHANTOMBOT_PERSONA = "ghost";
    const written: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string) => {
      written.push(String(c));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(await startTui({ prompt: "hi" })).toBe(2);
    } finally {
      process.stderr.write = realWrite;
    }
    expect(written.join("")).toContain("PHANTOMBOT_PERSONA");
  });
});
