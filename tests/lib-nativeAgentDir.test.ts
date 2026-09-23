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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  absorbLegacyNativeAgent,
  ensureNativeAgentDir,
  LEGACY_ABSORBED_MARKER,
  nativeAgentDir,
  nativeAgentEnv,
  nativeAuthPath,
  seedEphemeralAgentConfig,
} from "../src/lib/nativeAgentDir.ts";
import { removePiApiKey } from "../src/lib/piAuthStore.ts";

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

  test("absorb: migrated auth.json lands at 0600 regardless of process umask", () => {
    // Regression (round-6, Kai): the staged write must set mode 0600
    // explicitly — with the process umask 0o000 (worse than any real
    // shell's) the file used to come out 0666/0644, leaking copied API
    // keys to other local users.
    const dataHome = workspace();
    const legacy = nativeAgentDir(dataHome);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(
      join(legacy, "auth.json"),
      JSON.stringify({ openrouter: { type: "api_key", key: "sk-legacy" } }, null, 2) + "\n",
    );
    const prior = process.umask(0o000);
    let result: ReturnType<typeof absorbLegacyNativeAgent>;
    try {
      result = absorbLegacyNativeAgent(dataHome, "omar");
    } finally {
      process.umask(prior);
    }
    expect(result.auth).toBe(true);
    expect(statSync(nativeAuthPath(dataHome, "omar")).mode & 0o777).toBe(0o600);
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
    // Idempotent while the sentinel is intact: the marker — not the file's
    // existence — is the migration marker now (issue #609), so a hand-emptied
    // store behind an intact marker is left alone. The STRIP path deletes
    // the marker, and THAT is what re-arms the absorb (see the #609 tests).
    writeFileSync(join(dir, "auth.json"), "{}\n");
    ensureNativeAgentDir(dataHome, "lena");
    expect(readFileSync(join(dir, "auth.json"), "utf8")).toBe("{}\n");
  });
});
describe("nativeAgentDir issue #609 — sentinel migration marker (the strip re-arms the absorb)", () => {
  /** Seed the LEGACY host-level store and create the persona dir. */
  function seed(
    dataHome: string,
    legacy: Record<string, unknown>,
    persona = "omar",
  ): string {
    const legacyDir = nativeAgentDir(dataHome);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, "auth.json"),
      JSON.stringify(legacy, null, 2) + "\n",
    );
    return nativeAgentDir(dataHome, persona);
  }

  const LEGACY_KEYS = {
    openrouter: { type: "api_key", key: "sk-legacy-or" },
    google: { type: "api_key", key: "sk-legacy-goog" },
  };

  test("the #609 repro: absorb → strip until {} → re-ensure restores the legacy keys", async () => {
    // The field sequence from the issue: a non-relayed ensure absorbs the
    // legacy keys, subsequent relayed turns' pre-spawn strip removes them one
    // by one until the persona store is {}, and (pre-fix) "target exists"
    // then blocked the re-absorb permanently. The strip now deletes the
    // sentinel, so the next ensure restores the store.
    const dataHome = workspace();
    const own = seed(dataHome, LEGACY_KEYS);
    ensureNativeAgentDir(dataHome, "omar");
    expect(JSON.parse(readFileSync(join(own, "auth.json"), "utf8"))).toEqual(LEGACY_KEYS);
    expect(existsSync(join(own, LEGACY_ABSORBED_MARKER))).toBe(true);

    // Relayed-turn strips, one per provider, until the store is {}.
    for (const provider of ["openrouter", "google"]) {
      const strip = await removePiApiKey(provider, { agentDir: own });
      expect(strip).toMatchObject({ ok: true, removed: true });
    }
    expect(JSON.parse(readFileSync(join(own, "auth.json"), "utf8"))).toEqual({});
    // The strip invalidated the sentinel — that is the whole fix.
    expect(existsSync(join(own, LEGACY_ABSORBED_MARKER))).toBe(false);

    // The next (non-relayed) ensure re-absorbs the legacy keys intact.
    ensureNativeAgentDir(dataHome, "omar");
    expect(JSON.parse(readFileSync(join(own, "auth.json"), "utf8"))).toEqual(LEGACY_KEYS);
    expect(existsSync(join(own, LEGACY_ABSORBED_MARKER))).toBe(true);
    // The legacy source is never touched.
    expect(JSON.parse(readFileSync(join(nativeAgentDir(dataHome), "auth.json"), "utf8"))).toEqual(
      LEGACY_KEYS,
    );
  });

  test("the strip removes the sentinel only when it removes an entry", async () => {
    const dataHome = workspace();
    const own = seed(dataHome, LEGACY_KEYS);
    ensureNativeAgentDir(dataHome, "omar");
    const marker = join(own, LEGACY_ABSORBED_MARKER);

    // A no-op strip (provider absent) must NOT un-converge the migration.
    const noop = await removePiApiKey("anthropic", { agentDir: own });
    expect(noop).toMatchObject({ ok: true, removed: false });
    expect(existsSync(marker)).toBe(true);

    // A real strip does.
    const real = await removePiApiKey("openrouter", { agentDir: own });
    expect(real).toMatchObject({ ok: true, removed: true });
    expect(existsSync(marker)).toBe(false);
  });

  test("partial strip: re-ensure restores ONLY the stripped provider — siblings never clobbered", async () => {
    // The common field case is partial: relayed turns strip only the relayed
    // provider, so the store still holds the sibling when the next tier-2
    // ensure runs. Provider-level merge restores the stripped entry and
    // leaves the sibling byte-identical.
    const dataHome = workspace();
    const own = seed(dataHome, LEGACY_KEYS);
    ensureNativeAgentDir(dataHome, "omar");
    const strip = await removePiApiKey("openrouter", { agentDir: own });
    expect(strip).toMatchObject({ ok: true, removed: true });
    expect(JSON.parse(readFileSync(join(own, "auth.json"), "utf8"))).toEqual({
      google: LEGACY_KEYS.google,
    });

    ensureNativeAgentDir(dataHome, "omar");
    expect(JSON.parse(readFileSync(join(own, "auth.json"), "utf8"))).toEqual(LEGACY_KEYS);
  });

  test("wizard-written store: missing legacy providers merge in, own entries preserved, marker converges", () => {
    // A store the wizard wrote post-upgrade (round-4/5 doctrine: never
    // clobber) still inherits the legacy providers it is MISSING — pre-#606
    // that legacy store WAS this persona's fallback — while the wizard's own
    // entry wins over the legacy one for the same provider.
    const dataHome = workspace();
    const own = seed(dataHome, LEGACY_KEYS);
    mkdirSync(own, { recursive: true });
    const wizard = { openrouter: { type: "api_key", key: "sk-wizard-fresh" } };
    writeFileSync(join(own, "auth.json"), JSON.stringify(wizard, null, 2) + "\n");

    const result = absorbLegacyNativeAgent(dataHome, "omar");
    // google was missing → added; openrouter keeps the wizard's fresh key.
    expect(result.auth).toBe(true);
    const stored = JSON.parse(readFileSync(join(own, "auth.json"), "utf8"));
    expect(stored).toEqual({
      openrouter: { type: "api_key", key: "sk-wizard-fresh" },
      google: LEGACY_KEYS.google,
    });
    expect(existsSync(join(own, LEGACY_ABSORBED_MARKER))).toBe(true);
  });

  test("absorbAuth:false (a RELAYED turn) never writes the sentinel and never restores", async () => {
    // After the strips emptied the store, a relayed ensure must not restore
    // (the same turn's strip would empty it again) — restoration belongs to
    // the first genuinely tier-2 ensure.
    const dataHome = workspace();
    const own = seed(dataHome, LEGACY_KEYS);
    ensureNativeAgentDir(dataHome, "omar");
    await removePiApiKey("openrouter", { agentDir: own });
    await removePiApiKey("google", { agentDir: own });

    ensureNativeAgentDir(dataHome, "omar", { absorbAuth: false });
    expect(JSON.parse(readFileSync(join(own, "auth.json"), "utf8"))).toEqual({});
    expect(existsSync(join(own, LEGACY_ABSORBED_MARKER))).toBe(false);

    ensureNativeAgentDir(dataHome, "omar");
    expect(JSON.parse(readFileSync(join(own, "auth.json"), "utf8"))).toEqual(LEGACY_KEYS);
  });

  test("unparseable persona store: refused, no marker — retried on the next ensure", () => {
    // Unknown state is never clobbered (round-5 doctrine): a store we cannot
    // interpret blocks the absorb AND the marker, so the migration retries
    // once the store is fixed — it cannot silently converge away.
    const dataHome = workspace();
    const own = seed(dataHome, LEGACY_KEYS);
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "auth.json"), "not json at all\n");

    expect(absorbLegacyNativeAgent(dataHome, "omar").auth).toBe(false);
    expect(existsSync(join(own, LEGACY_ABSORBED_MARKER))).toBe(false);
    expect(readFileSync(join(own, "auth.json"), "utf8")).toBe("not json at all\n");

    // Fixed by the operator → the retry absorbs.
    writeFileSync(join(own, "auth.json"), "{}\n");
    expect(absorbLegacyNativeAgent(dataHome, "omar").auth).toBe(true);
    expect(JSON.parse(readFileSync(join(own, "auth.json"), "utf8"))).toEqual(LEGACY_KEYS);
  });

  test("oauth-only legacy store converges behind the marker: no re-absorb loop", () => {
    // filteredLegacyAuth legitimately returns {} (oauth-only legacy store);
    // the marker — not a non-empty store — is what converges it, so the next
    // absorb is a no-op rather than a re-read every ensure().
    const dataHome = workspace();
    const own = seed(dataHome, { openrouter: { type: "oauth", access: "legacy-oauth" } });
    expect(absorbLegacyNativeAgent(dataHome, "omar").auth).toBe(true);
    expect(JSON.parse(readFileSync(join(own, "auth.json"), "utf8"))).toEqual({});
    expect(existsSync(join(own, LEGACY_ABSORBED_MARKER))).toBe(true);
    expect(absorbLegacyNativeAgent(dataHome, "omar")).toEqual({ auth: false, configFiles: [] });
  });
});
describe("nativeAgentDir round-7 — relayed-turn auth-absorb skip + dir modes", () => {
  test("absorbAuth:false (a RELAYED turn) skips the auth absorb — config still inherits, legacy key survives for tier-2 (round-7, Robbie/Kai)", () => {
    // The consume-and-block cycle this prevents: a persona's FIRST
    // post-upgrade turn is relayed (phantombot routing), the absorb copies
    // the legacy key into the persona store, the pre-spawn strip empties it,
    // and "target exists" then blocks every later absorb — the persona
    // silently loses its documented tier-2 fallback. With the skip, nothing
    // is written on the relayed turn and the first tier-2 turn migrates
    // intact.
    const dataHome = workspace();
    const legacy = nativeAgentDir(dataHome);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(
      join(legacy, "auth.json"),
      JSON.stringify({ openrouter: { type: "api_key", key: "sk-legacy-shared" } }, null, 2) + "\n",
    );
    writeFileSync(
      join(legacy, "settings.json"),
      JSON.stringify({ defaultModel: "legacy-model" }, null, 2) + "\n",
    );
    // RELAYED turn: ensure with absorbAuth:false. No auth.json created ...
    const dir = ensureNativeAgentDir(dataHome, "omar", { absorbAuth: false });
    expect(existsSync(join(dir, "auth.json"))).toBe(false);
    // ... but local-config files still inherit (no strip touches those).
    expect(readFileSync(join(dir, "settings.json"), "utf8")).toContain("legacy-model");
    // The relayed turn's strip then writes NOTHING (absent store = no-op),
    // and the next tier-2 ensure absorbs the legacy credential intact.
    ensureNativeAgentDir(dataHome, "omar");
    expect(JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"))).toEqual({
      openrouter: { type: "api_key", key: "sk-legacy-shared" },
    });
    // The legacy source is never touched.
    expect(JSON.parse(readFileSync(join(legacy, "auth.json"), "utf8"))).toEqual({
      openrouter: { type: "api_key", key: "sk-legacy-shared" },
    });
  });

  test("ensureNativeAgentDir creates root/personas/<persona>/agent at 0700 under a 0002 umask (round-7, Kai)", () => {
    // Regression (round-7, Kai/Robbie): mkdirSync without a mode inherits
    // the process umask — 0002 made the persona dirs 0775, group-writable,
    // so another local user could unlink/substitute auth.json (0600) or
    // inject a models.json with a hostile base URL. Explicit 0700 is
    // umask-masked, so it survives.
    const dataHome = workspace();
    const prior = process.umask(0o002); // the host's real umask per the reviews
    try {
      const dir = ensureNativeAgentDir(dataHome, "omar");
      for (const p of [
        join(dataHome, "pi-native"),
        join(dataHome, "pi-native", "personas"),
        join(dataHome, "pi-native", "personas", "omar"),
        dir,
      ]) {
        expect(statSync(p).mode & 0o777).toBe(0o700);
      }
    } finally {
      process.umask(prior);
    }
  });

  test("seedEphemeralAgentConfig copies legacy config files, NEVER auth.json (round-7, Robbie non-blocking 2)", () => {
    const dataHome = workspace();
    const legacy = nativeAgentDir(dataHome);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "sk-legacy" } }) + "\n");
    writeFileSync(join(legacy, "models.json"), JSON.stringify({ custom: true }) + "\n");
    const ephemeral = mkdtempSync(join(tmpdir(), "ephemeral-agent-"));
    try {
      seedEphemeralAgentConfig(ephemeral, dataHome);
      expect(JSON.parse(readFileSync(join(ephemeral, "models.json"), "utf8"))).toEqual({ custom: true });
      expect(existsSync(join(ephemeral, "auth.json"))).toBe(false);
      // Never clobbers a file already present.
      writeFileSync(join(ephemeral, "models.json"), '{"own":true}\n');
      seedEphemeralAgentConfig(ephemeral, dataHome);
      expect(readFileSync(join(ephemeral, "models.json"), "utf8")).toBe('{"own":true}\n');
    } finally {
      rmSync(ephemeral, { recursive: true, force: true });
    }
  });
});
