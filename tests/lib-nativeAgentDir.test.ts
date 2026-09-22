/**
 * Persona-scoped native agent dirs (PR #606 round-4 review).
 *
 * The native agent dir is PER-PERSONA — `personas/<persona>/agent` under the
 * native root — because its auth.json holds per-persona credentials. A shared
 * host-level file made one persona's stored key decide every persona's turns
 * (Robbie's round-3/4 blockers: the strip destroyed a sibling's tier-2
 * fallback; an oauth login deadlocked every relayed turn). The LEGACY
 * host-level dir remains for bare hand-runs and as the migration source each
 * persona's first ensure() absorbs from.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  absorbLegacyNativeAuth,
  ensureNativeAgentDir,
  nativeAgentDir,
  nativeAgentEnv,
  nativeAuthPath,
} from "../src/lib/nativeAgentDir.ts";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "native-agent-dir-"));
}

describe("nativeAgentDir persona scoping", () => {
  test("with a persona: personas/<persona>/agent; without: the legacy host-level dir", () => {
    const dataHome = workspace();
    expect(nativeAgentDir(dataHome, "omar")).toBe(
      join(dataHome, "pi-native", "personas", "omar", "agent"),
    );
    expect(nativeAgentDir(dataHome)).toBe(join(dataHome, "pi-native", "agent"));
    expect(nativeAuthPath(dataHome, "omar")).toBe(
      join(dataHome, "pi-native", "personas", "omar", "agent", "auth.json"),
    );
  });

  test("nativeAgentEnv points PI_CODING_AGENT_DIR at the persona dir and creates it", () => {
    const dataHome = workspace();
    const env = nativeAgentEnv(dataHome, "omar");
    expect(env.PI_CODING_AGENT_DIR).toBe(join(dataHome, "pi-native", "personas", "omar", "agent"));
    expect(existsSync(env.PI_CODING_AGENT_DIR)).toBe(true);
  });

  test("absorb: no legacy store → no-op, persona store stays empty", () => {
    const dataHome = workspace();
    mkdirSync(nativeAgentDir(dataHome, "omar"), { recursive: true });
    expect(absorbLegacyNativeAuth(dataHome, "omar")).toBe(false);
    expect(existsSync(nativeAuthPath(dataHome, "omar"))).toBe(false);
  });

  test("absorb: copies the legacy auth.json verbatim (oauth included)", () => {
    const dataHome = workspace();
    const legacy = nativeAgentDir(dataHome);
    mkdirSync(legacy, { recursive: true });
    const legacyAuth = {
      openrouter: { type: "api_key", key: "sk-legacy" },
      anthropic: { type: "oauth", access: "legacy-oauth" },
    };
    writeFileSync(join(legacy, "auth.json"), JSON.stringify(legacyAuth, null, 2) + "\n");
    expect(absorbLegacyNativeAuth(dataHome, "omar")).toBe(true);
    expect(JSON.parse(readFileSync(nativeAuthPath(dataHome, "omar"), "utf8"))).toEqual(legacyAuth);
    // The legacy file survives — it is the migration source for other personas.
    expect(existsSync(join(legacy, "auth.json"))).toBe(true);
  });

  test("absorb: never clobbers an existing persona store", () => {
    const dataHome = workspace();
    const legacy = nativeAgentDir(dataHome);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(
      join(legacy, "auth.json"),
      JSON.stringify({ openrouter: { type: "api_key", key: "sk-legacy" } }) + "\n",
    );
    const own = nativeAgentDir(dataHome, "omar");
    mkdirSync(own, { recursive: true });
    const ownAuth = { openrouter: { type: "oauth", access: "own-login" } };
    writeFileSync(join(own, "auth.json"), JSON.stringify(ownAuth, null, 2) + "\n");
    expect(absorbLegacyNativeAuth(dataHome, "omar")).toBe(false);
    expect(JSON.parse(readFileSync(join(own, "auth.json"), "utf8"))).toEqual(ownAuth);
  });

  test("ensureNativeAgentDir creates the persona dir and absorbs in one step", () => {
    const dataHome = workspace();
    const legacy = nativeAgentDir(dataHome);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(
      join(legacy, "auth.json"),
      JSON.stringify({ openrouter: { type: "api_key", key: "sk-legacy" } }) + "\n",
    );
    const dir = ensureNativeAgentDir(dataHome, "lena");
    expect(dir).toBe(join(dataHome, "pi-native", "personas", "lena", "agent"));
    expect(existsSync(join(dir, "auth.json"))).toBe(true);
    // Idempotent: a second ensure leaves the (possibly since-stripped) store alone.
    writeFileSync(join(dir, "auth.json"), "{}\n");
    ensureNativeAgentDir(dataHome, "lena");
    expect(readFileSync(join(dir, "auth.json"), "utf8")).toBe("{}\n");
  });
});
