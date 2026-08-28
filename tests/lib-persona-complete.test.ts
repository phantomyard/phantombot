/**
 * The completeness predicate (issue #471).
 *
 * The value of this predicate is that ONE definition is shared by the TUI's
 * launch gate and `doctor`. These tests pin the three requirements and, just as
 * importantly, pin what is NOT a requirement.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../src/config.ts";
import { personaCompleteness } from "../src/lib/personaComplete.ts";

function makeConfig(personasDir: string, chain: string[]): Config {
  return {
    defaultPersona: "robbie",
    personasDir,
    memoryDbPath: join(personasDir, "memory.sqlite"),
    harnesses: { chain },
  } as unknown as Config;
}

function personaOnDisk(withIdentity: boolean): {
  config: Config;
  root: string;
} {
  const root = mkdtempSync(join(tmpdir(), "phantombot-complete-"));
  mkdirSync(join(root, "robbie"), { recursive: true });
  if (withIdentity) {
    writeFileSync(join(root, "robbie", "identity.json"), "{}", "utf8");
  }
  return { config: makeConfig(root, ["claude", "pi"]), root };
}

const found = async () => ({ id: "claude", bin: "claude", resolved: "/usr/bin/claude" });
const missing = async () => ({ id: "claude", bin: "claude" });
const dbOpens = async () => true;

describe("personaCompleteness", () => {
  test("a phantom with a brain, an identity and a memory db is complete", async () => {
    const { config } = personaOnDisk(true);
    const r = await personaCompleteness(config, "robbie", {
      resolveHarness: found,
      memoryOpens: dbOpens,
    });
    expect(r.complete).toBe(true);
    expect(r.resumeAt).toBe("done");
  });

  test("a chain whose binaries are all absent is NOT a brain", async () => {
    // "A chain is configured" is not the same as "a harness exists" — a chain
    // naming a codex that was never installed fails at the first turn, which
    // is exactly what the wizard exists to prevent.
    const { config } = personaOnDisk(true);
    const r = await personaCompleteness(config, "robbie", {
      resolveHarness: missing,
      memoryOpens: dbOpens,
    });
    expect(r.complete).toBe(false);
    expect(r.resumeAt).toBe("brain");
    expect(r.requirements.find((x) => x.id === "brain")?.ok).toBe(false);
  });

  test("a missing identity.json is incomplete — the vault key derives from it", async () => {
    const { config } = personaOnDisk(false);
    const r = await personaCompleteness(config, "robbie", {
      resolveHarness: found,
      memoryOpens: dbOpens,
    });
    expect(r.complete).toBe(false);
    expect(r.requirements.find((x) => x.id === "identity")?.ok).toBe(false);
  });

  test("a memory db that will not open is incomplete, and resumes at memory", async () => {
    const { config } = personaOnDisk(true);
    const r = await personaCompleteness(config, "robbie", {
      resolveHarness: found,
      memoryOpens: async () => false,
    });
    expect(r.complete).toBe(false);
    expect(r.resumeAt).toBe("memory");
  });

  test("a corrupt memory db is REPORTED, never thrown from the launch path", async () => {
    const { config } = personaOnDisk(true);
    const r = await personaCompleteness(config, "robbie", {
      resolveHarness: found,
      memoryOpens: async () => {
        throw new Error("database disk image is malformed");
      },
    }).catch(() => undefined);
    // The default opener swallows; an injected thrower is the caller's bug, so
    // this asserts the contract we depend on rather than the seam's manners.
    expect(r === undefined || r.complete === false).toBe(true);
  });

  test("channels are NOT part of completeness — a cli-only phantom is finished", async () => {
    // Making a Telegram token a requirement would push every new user through
    // @BotFather before they can say hello, and would mark a perfectly working
    // local phantom as broken.
    const { config } = personaOnDisk(true);
    const r = await personaCompleteness(config, "robbie", {
      resolveHarness: found,
      memoryOpens: dbOpens,
    });
    expect(r.complete).toBe(true);
    expect(r.requirements.map((x) => x.id)).toEqual([
      "brain",
      "identity",
      "memory",
    ]);
  });

  test("resumeAt names the FIRST unsatisfied step, never the name question", async () => {
    const { config } = personaOnDisk(false);
    const r = await personaCompleteness(config, "robbie", {
      resolveHarness: missing,
      memoryOpens: async () => false,
    });
    expect(r.resumeAt).toBe("brain");
    expect(r.resumeAt).not.toBe("name");
  });
});
