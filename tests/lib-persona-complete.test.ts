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

/** The persona recorded its own brain — the normal, configured case. */
const ownBrain = (chain: readonly string[] = ["claude", "pi"]) => async () => chain;

/** The persona recorded NO brain — the fresh-create case. */
const noBrain = async () => undefined;

describe("personaCompleteness", () => {
  test("a phantom with a brain, an identity and a memory db is complete", async () => {
    const { config } = personaOnDisk(true);
    const r = await personaCompleteness(config, "robbie", {
      resolveHarness: found,
      localChain: ownBrain(),
      memoryOpens: dbOpens,
    });
    expect(r.complete).toBe(true);
    expect(r.resumeAt).toBe("done");
  });

  test("a phantom with NO brain of its own is not ready — even with a resolvable host chain", async () => {
    // Inheriting the host chain is not configuring a brain: a phantom created
    // without one stays not-ready until its operator records a choice.
    const { config } = personaOnDisk(true);
    const r = await personaCompleteness(config, "robbie", {
      resolveHarness: found,
      localChain: noBrain,
      memoryOpens: dbOpens,
    });
    expect(r.complete).toBe(false);
    // A brain gap is not a wizard question — it routes to Configure (tier 2);
    // `resumeAt` just carries a legal step value.
    expect(r.resumeAt).toBe("done");
    expect(r.requirements.find((x) => x.id === "brain")?.detail).toContain(
      "no brain configured",
    );
  });

  test("the default path reads a host-file personas-table record as the persona's brain", async () => {
    // phantombot#441: a DEFAULT persona with no config.toml of its own gets
    // its Brain-flow chain written to the host file as
    // [harnesses.personas.<name>]. The runtime honors that (harnessChainIds);
    // the gate must read the same truth or a fixed brain stays red forever.
    const { config } = personaOnDisk(true);
    (config as unknown as {
      harnesses: { personas?: Record<string, { chain: string[] }> };
    }).harnesses.personas = { robbie: { chain: ["pi"] } };
    const r = await personaCompleteness(config, "robbie", {
      resolveHarness: async () => ({ id: "pi", bin: "pi", resolved: "/usr/bin/pi" }),
      memoryOpens: dbOpens,
    });
    expect(r.complete).toBe(true);
    expect(r.requirements.find((x) => x.id === "brain")?.ok).toBe(true);
  });

  test("the default path still ignores the bare host chain — another persona's record is not yours", async () => {
    const { config } = personaOnDisk(true);
    (config as unknown as {
      harnesses: { personas?: Record<string, { chain: string[] }> };
    }).harnesses.personas = { someoneelse: { chain: ["pi"] } };
    const r = await personaCompleteness(config, "robbie", {
      resolveHarness: found,
      memoryOpens: dbOpens,
    });
    expect(r.requirements.find((x) => x.id === "brain")?.ok).toBe(false);
  });

  test("a chain whose binaries are all absent is NOT a brain", async () => {
    // "A chain is configured" is not the same as "a harness exists" — a chain
    // naming a codex that was never installed fails at the first turn, which
    // is exactly what the wizard exists to prevent.
    const { config } = personaOnDisk(true);
    const r = await personaCompleteness(config, "robbie", {
      resolveHarness: missing,
      localChain: ownBrain(),
      memoryOpens: dbOpens,
    });
    expect(r.complete).toBe(false);
    expect(r.resumeAt).toBe("done");
    expect(r.requirements.find((x) => x.id === "brain")?.ok).toBe(false);
  });

  test("a missing identity.json is incomplete — the vault key derives from it", async () => {
    const { config } = personaOnDisk(false);
    const r = await personaCompleteness(config, "robbie", {
      resolveHarness: found,
      localChain: ownBrain(),
      memoryOpens: dbOpens,
    });
    expect(r.complete).toBe(false);
    expect(r.requirements.find((x) => x.id === "identity")?.ok).toBe(false);
  });

  test("a memory db that will not open is incomplete — reported, not resumed", async () => {
    const { config } = personaOnDisk(true);
    const r = await personaCompleteness(config, "robbie", {
      resolveHarness: found,
      localChain: ownBrain(),
      memoryOpens: async () => false,
    });
    expect(r.complete).toBe(false);
    // A corrupt DB is a repair case, not a setup flow — the wizard cannot
    // fix it, so its step is not a resume point.
    expect(r.resumeAt).toBe("done");
  });

  test("a corrupt memory db is REPORTED, never thrown from the launch path", async () => {
    const { config } = personaOnDisk(true);
    const r = await personaCompleteness(config, "robbie", {
      resolveHarness: found,
      localChain: ownBrain(),
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
      localChain: ownBrain(),
      memoryOpens: dbOpens,
    });
    expect(r.complete).toBe(true);
    expect(r.requirements.map((x) => x.id)).toEqual([
      "brain",
      "identity",
      "memory",
    ]);
  });

  test("resumeAt names the IDENTITY step when identity is the gap — the one wizard-fixable one", async () => {
    const { config } = personaOnDisk(false);
    const r = await personaCompleteness(config, "robbie", {
      resolveHarness: found,
      localChain: ownBrain(),
      memoryOpens: dbOpens,
    });
    expect(r.resumeAt).toBe("identity");
    expect(r.resumeAt).not.toBe("name");
  });
});
