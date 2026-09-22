/**
 * Persona-scoped native agent dirs (PR #606 rounds 4-5 review).
 *
 * The native agent dir is PER-PERSONA — `personas/<persona>/agent` under the
 * native root — because its auth.json holds per-persona credentials. A shared
 * host-level file made one persona's stored key decide every persona's turns
 * (Robbie's round-3/4 blockers: the strip destroyed a sibling's tier-2
 * fallback; an oauth login deadlocked every relayed turn). The LEGACY
 * host-level dir remains the agent dir for a bare persona-less NON-relayed
 * hand-run and the read-only migration source each persona's first ensure()
 * absorbs from — auth.json OAUTH-FILTERED (round-5, Robbie: one operator's
 * login must not become every persona's stored fallback or abort) plus the
 * local-config files pi resolves `useLocalConfig` turns from, verbatim
 * (round-5, Kai: settings/models must survive the scoping upgrade).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  absorbLegacyNativeAgent,
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
    const agentDir = nativeAgentEnv(dataHome, "omar").PI_CODING_AGENT_DIR!;
    expect(agentDir).toBe(join(dataHome, "pi-native", "personas", "omar", "agent"));
    expect(existsSync(agentDir)).toBe(true);
  });

  test("absorb: no legacy dir → no-op, persona store stays empty", () => {
    const dataHome = workspace();
    mkdirSync(nativeAgentDir(dataHome, "omar"), { recursive: true });
    expect(absorbLegacyNativeAgent(dataHome, "omar")).toEqual({ auth: false, configFiles: [] });
    expect(existsSync(nativeAuthPath(dataHome, "omar"))).toBe(false);
  });

  test("absorb: auth.json is copied OAUTH-FILTERED — api_key entries only (round-5, Robbie)", () => {
    // The legacy shared store has no persona attribution: exactly one
    // operator made that interactive oauth login. Absorbing it into every
    // persona would make the fail-closed oauth abort fire on every persona's
    // first relayed turn. Only api_key entries are inherited.
    const dataHome = workspace();
    const legacy = nativeAgentDir(dataHome);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(
      join(legacy, "auth.json"),
      JSON.stringify(
        {
          openrouter: { type: "api_key", key: "sk-legacy" },
          anthropic: { type: "oauth", access: "legacy-oauth" },
        },
        null,
        2,
      ) + "\n",
    );
    expect(absorbLegacyNativeAgent(dataHome, "omar").auth).toBe(true);
    expect(JSON.parse(readFileSync(nativeAuthPath(dataHome, "omar"), "utf8"))).toEqual({
      openrouter: { type: "api_key", key: "sk-legacy" },
    });
    // The legacy file survives untouched — it is the migration source for
    // every other persona.
    expect(JSON.parse(readFileSync(join(legacy, "auth.json"), "utf8"))).toEqual({
      openrouter: { type: "api_key", key: "sk-legacy" },
      anthropic: { type: "oauth", access: "legacy-oauth" },
    });
  });

  test("absorb: an oauth-ONLY legacy store converges to {} — no stored fallback, no retry loop", () => {
    const dataHome = workspace();
    const legacy = nativeAgentDir(dataHome);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(
      join(legacy, "auth.json"),
      JSON.stringify({ openrouter: { type: "oauth", access: "legacy-oauth" } }, null, 2) + "\n",
    );
    expect(absorbLegacyNativeAgent(dataHome, "omar").auth).toBe(true);
    expect(JSON.parse(readFileSync(nativeAuthPath(dataHome, "omar"), "utf8"))).toEqual({});
    // Converged: a second absorb is a no-op, not a re-read of the legacy file.
    expect(absorbLegacyNativeAgent(dataHome, "omar")).toEqual({ auth: false, configFiles: [] });
  });

  test("absorb: an unparseable legacy auth.json is refused — but config files still inherit", () => {
    const dataHome = workspace();
    const legacy = nativeAgentDir(dataHome);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "auth.json"), "not json at all\n");
    writeFileSync(join(legacy, "settings.json"), '{"defaultModel":"legacy-model"}\n');
    const result = absorbLegacyNativeAgent(dataHome, "omar");
    expect(result.auth).toBe(false);
    expect(result.configFiles).toEqual(["settings.json"]);
    expect(existsSync(nativeAuthPath(dataHome, "omar"))).toBe(false);
    expect(readFileSync(join(nativeAgentDir(dataHome, "omar"), "settings.json"), "utf8")).toBe(
      '{"defaultModel":"legacy-model"}\n',
    );
  });

  test("absorb: local-config files inherit verbatim (round-5, Kai) and never clobber", () => {
    const dataHome = workspace();
    const legacy = nativeAgentDir(dataHome);
    mkdirSync(legacy, { recursive: true });
    for (const name of ["settings.json", "models.json", "models-store.json"]) {
      writeFileSync(join(legacy, name), `{"from":"legacy-${name}"}` + "\n");
    }
    const own = nativeAgentDir(dataHome, "omar");
    mkdirSync(own, { recursive: true });
    // A config file the persona already has (post-upgrade or wizard-written)
    // is never overwritten.
    writeFileSync(join(own, "settings.json"), '{"from":"own"}' + "\n");
    const result = absorbLegacyNativeAgent(dataHome, "omar");
    expect(result.configFiles.sort()).toEqual(["models-store.json", "models.json"]);
    expect(readFileSync(join(own, "settings.json"), "utf8")).toBe('{"from":"own"}\n');
    expect(readFileSync(join(own, "models.json"), "utf8")).toBe('{"from":"legacy-models.json"}\n');
    expect(readFileSync(join(own, "models-store.json"), "utf8")).toBe(
      '{"from":"legacy-models-store.json"}\n',
    );
  });

  test("absorb: never clobbers an existing persona auth store", () => {
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
    expect(absorbLegacyNativeAgent(dataHome, "omar").auth).toBe(false);
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