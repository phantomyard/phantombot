/**
 * Encrypted vault: the security-critical core of PR #253.
 *
 * These tests exercise the REAL crypto and storage (no injected fakes):
 *   - AES-256-GCM encrypt→decrypt round-trips and survives reopen.
 *   - the WRONG persona key is REJECTED (GCM auth failure), not silently
 *     mis-decrypted — the whole per-persona isolation guarantee.
 *   - HKDF key derivation is deterministic and secret-separating.
 *   - the vault is a SINGLE self-contained file (no WAL sidecar) so the
 *     "copy the persona folder and secrets travel" promise holds.
 *   - loadVaultIntoEnv reconciles per-persona: sticky boot keys win, a
 *     freshly-saved value appears, and switching personas strips the previous
 *     persona's secrets (no cross-persona leak).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateSecretKey } from "nostr-tools/pure";

import { Database } from "bun:sqlite";

import { rmrf } from "./fixtures/rmrf.ts";

import {
  _resetVaultTrackingForTesting,
  _resetVaultWarningsForTesting,
  deriveVaultKey,
  loadVaultIntoEnv,
  openPersonaVault,
  openVaultWithSecret,
  vaultPath,
} from "../src/lib/vault.ts";

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-vault-"));
  _resetVaultTrackingForTesting();
  _resetVaultWarningsForTesting();
});

afterEach(async () => {
  // rmrf retries on Windows EBUSY: a bun:sqlite handle can linger a few ms after
  // close(), racing the recursive delete. No-op-fast on POSIX. See fixtures/rmrf.
  await rmrf(workdir);
});

describe("vault crypto round-trip", () => {
  test("set → get returns the exact value", () => {
    const secret = generateSecretKey();
    const dir = join(workdir, "p");
    const vault = openVaultWithSecret(dir, secret);
    try {
      vault.set("GITHUB_TOKEN", "ghp_supersecret_value");
      expect(vault.get("GITHUB_TOKEN")).toBe("ghp_supersecret_value");
    } finally {
      vault.close();
    }
  });

  test("values survive close + reopen with the same secret", () => {
    const secret = generateSecretKey();
    const dir = join(workdir, "p");
    let v = openVaultWithSecret(dir, secret);
    v.set("API_KEY", "value-one");
    v.close();

    v = openVaultWithSecret(dir, secret);
    try {
      expect(v.get("API_KEY")).toBe("value-one");
    } finally {
      v.close();
    }
  });

  test("empty-string and unicode values round-trip", () => {
    const secret = generateSecretKey();
    const v = openVaultWithSecret(join(workdir, "p"), secret);
    try {
      v.set("EMPTY", "");
      v.set("UNICODE", "clé—日本語—🔐");
      expect(v.get("EMPTY")).toBe("");
      expect(v.get("UNICODE")).toBe("clé—日本語—🔐");
    } finally {
      v.close();
    }
  });

  test("get on an absent name returns undefined", () => {
    const v = openVaultWithSecret(join(workdir, "p"), generateSecretKey());
    try {
      expect(v.get("NOPE")).toBeUndefined();
    } finally {
      v.close();
    }
  });

  test("set replaces (upsert), unset removes", () => {
    const v = openVaultWithSecret(join(workdir, "p"), generateSecretKey());
    try {
      v.set("K", "first");
      v.set("K", "second");
      expect(v.get("K")).toBe("second");
      v.unset("K");
      expect(v.get("K")).toBeUndefined();
      // unset of an absent key is a no-op, not an error.
      v.unset("K");
    } finally {
      v.close();
    }
  });

  test("list returns names only, sorted, never values", () => {
    const v = openVaultWithSecret(join(workdir, "p"), generateSecretKey());
    try {
      v.set("ZEBRA", "z");
      v.set("ALPHA", "a");
      v.set("MIKE", "m");
      expect(v.list()).toEqual(["ALPHA", "MIKE", "ZEBRA"]);
    } finally {
      v.close();
    }
  });
});

describe("per-persona key isolation", () => {
  test("a DIFFERENT secret cannot decrypt — GCM rejects, never silent", () => {
    const dir = join(workdir, "p");
    const secretA = generateSecretKey();
    const secretB = generateSecretKey();

    const a = openVaultWithSecret(dir, secretA);
    a.set("SECRET", "only-A-can-read");
    a.close();

    // Reopen the SAME db file with a WRONG key. The row is there, but decrypt
    // must throw on the auth-tag mismatch — not return garbage, not return the
    // value.
    const b = openVaultWithSecret(dir, secretB);
    try {
      expect(() => b.get("SECRET")).toThrow();
    } finally {
      b.close();
    }
  });

  test("deriveVaultKey is deterministic, 32 bytes, and secret-separating", () => {
    const s1 = generateSecretKey();
    const s2 = generateSecretKey();
    const k1a = deriveVaultKey(s1);
    const k1b = deriveVaultKey(s1);
    const k2 = deriveVaultKey(s2);

    expect(k1a.length).toBe(32);
    expect(Buffer.from(k1a).equals(Buffer.from(k1b))).toBe(true); // deterministic
    expect(Buffer.from(k1a).equals(Buffer.from(k2))).toBe(false); // separates
  });

  test("the derived key is NOT the raw nsec bytes (HKDF isolation)", () => {
    const secret = generateSecretKey();
    const key = deriveVaultKey(secret);
    expect(Buffer.from(key).equals(Buffer.from(secret))).toBe(false);
  });
});

describe("single-file portability (no WAL sidecar)", () => {
  test("after close, no -wal/-shm sidecar remains beside vault.sqlite", () => {
    const dir = join(workdir, "p");
    const v = openVaultWithSecret(dir, generateSecretKey());
    v.set("K", "v");
    v.close();

    const base = vaultPath(dir);
    expect(existsSync(base)).toBe(true);
    expect(existsSync(`${base}-wal`)).toBe(false);
    expect(existsSync(`${base}-shm`)).toBe(false);
  });

  test("copying ONLY vault.sqlite to another dir still decrypts", async () => {
    const secret = generateSecretKey();
    const srcDir = join(workdir, "src");
    const v = openVaultWithSecret(srcDir, secret);
    v.set("PORTABLE", "travels-with-the-folder");
    v.close();

    const dstDir = join(workdir, "dst");
    await mkdir(dstDir, { recursive: true });
    await copyFile(vaultPath(srcDir), vaultPath(dstDir));

    const moved = openVaultWithSecret(dstDir, secret);
    try {
      expect(moved.get("PORTABLE")).toBe("travels-with-the-folder");
    } finally {
      moved.close();
    }
  });
});

describe("loadVaultIntoEnv reconcile", () => {
  test("loads new vault keys into an empty env and tracks them", async () => {
    const dir = join(workdir, "p");
    const v = await openPersonaVault(dir);
    v.set("BAR", "from-vault");
    v.close();

    const env: NodeJS.ProcessEnv = {};
    const tracked = new Set<string>();
    const { updated, removed } = await loadVaultIntoEnv(dir, env, tracked);

    expect(env.BAR).toBe("from-vault");
    expect(updated).toContain("BAR");
    expect(removed).toEqual([]);
    expect(tracked.has("BAR")).toBe(true);
  });

  test("open-existing-only: a never-provisioned persona dir is NOT created on load", async () => {
    // Regression: the startup bootstrap loads the default persona's vault to
    // populate env. That load must never conjure the persona on disk - otherwise
    // `persona new test` on a fresh box also silently creates a stray `phantom`.
    const dir = join(workdir, "never-provisioned");
    expect(existsSync(dir)).toBe(false);

    const env: NodeJS.ProcessEnv = {};
    const tracked = new Set<string>();
    const { updated, removed } = await loadVaultIntoEnv(dir, env, tracked);

    // No dir, no identity.json, no vault.sqlite materialized.
    expect(existsSync(dir)).toBe(false);
    expect(updated).toEqual([]);
    expect(removed).toEqual([]);
  });

  test("existing env value is sticky — vault never overwrites it", async () => {
    const dir = join(workdir, "p");
    const v = await openPersonaVault(dir);
    v.set("FOO", "vault-value");
    v.close();

    const env: NodeJS.ProcessEnv = { FOO: "shell-export" };
    const tracked = new Set<string>();
    const { updated } = await loadVaultIntoEnv(dir, env, tracked);

    expect(env.FOO).toBe("shell-export"); // sticky wins
    expect(updated).not.toContain("FOO");
    expect(tracked.has("FOO")).toBe(false);
  });

  test("switching personas swaps the token and strips the previous persona's keys", async () => {
    const dirA = join(workdir, "A");
    const a = await openPersonaVault(dirA);
    a.set("TOKEN", "aaa");
    a.set("ONLY_A", "1");
    a.close();

    const dirB = join(workdir, "B");
    const b = await openPersonaVault(dirB);
    b.set("TOKEN", "bbb");
    b.close();

    const env: NodeJS.ProcessEnv = {};
    const tracked = new Set<string>();

    await loadVaultIntoEnv(dirA, env, tracked);
    expect(env.TOKEN).toBe("aaa");
    expect(env.ONLY_A).toBe("1");

    const r = await loadVaultIntoEnv(dirB, env, tracked);
    expect(env.TOKEN).toBe("bbb"); // updated to persona B's value
    expect(env.ONLY_A).toBeUndefined(); // persona A's key stripped
    expect(r.removed).toContain("ONLY_A");
    expect(tracked.has("ONLY_A")).toBe(false);
  });

  test("a value saved to the vault becomes visible on the next reconcile", async () => {
    const dir = join(workdir, "p");
    let v = await openPersonaVault(dir);
    v.set("SECRET", "v1");
    v.close();

    const env: NodeJS.ProcessEnv = {};
    const tracked = new Set<string>();
    await loadVaultIntoEnv(dir, env, tracked);
    expect(env.SECRET).toBe("v1");

    // Simulate a `vault set` from a later turn: rewrite the value on disk.
    v = await openPersonaVault(dir);
    v.set("SECRET", "v2");
    v.close();

    const r = await loadVaultIntoEnv(dir, env, tracked);
    expect(env.SECRET).toBe("v2");
    expect(r.updated).toContain("SECRET");
  });

  test("fail-closed: an unreadable different-persona vault strips prior keys", async () => {
    const dirA = join(workdir, "A");
    const a = await openPersonaVault(dirA);
    a.set("TOKEN", "aaa");
    a.close();

    const env: NodeJS.ProcessEnv = {};
    const tracked = new Set<string>();
    await loadVaultIntoEnv(dirA, env, tracked);
    expect(env.TOKEN).toBe("aaa");

    // Point at a path that is a FILE, so opening a vault under it throws
    // (mkdir over a file fails) → readAllVaultValues returns null.
    const badPath = join(workdir, "not-a-dir");
    await writeFile(badPath, "x");
    const r = await loadVaultIntoEnv(badPath, env, tracked);

    expect(env.TOKEN).toBeUndefined(); // stripped — no leak into the failed turn
    expect(r.removed).toContain("TOKEN");
  });
});

describe("per-row resilience — one bad row never blanks the vault", () => {
  /** Corrupt a single row's ciphertext in place so GCM auth rejects it. */
  function corruptRow(dir: string, name: string): void {
    const db = new Database(vaultPath(dir));
    db.prepare("UPDATE secrets SET ciphertext = ? WHERE name = ?").run(
      Buffer.from(crypto.getRandomValues(new Uint8Array(48))),
      name,
    );
    db.close();
  }

  test("a corrupt row is skipped; every other secret still loads", async () => {
    const dir = join(workdir, "p");
    const v = await openPersonaVault(dir);
    v.set("GITHUB_TOKEN", "good-1");
    v.set("SENTRY_DSN", "poisoned");
    v.set("OPENAI_API_KEY", "good-2");
    v.close();

    corruptRow(dir, "SENTRY_DSN");

    const env: NodeJS.ProcessEnv = {};
    const tracked = new Set<string>();
    await loadVaultIntoEnv(dir, env, tracked);

    // The good secrets are untouched by the one poisoned neighbour.
    expect(env.GITHUB_TOKEN).toBe("good-1");
    expect(env.OPENAI_API_KEY).toBe("good-2");
    // The bad row is skipped, not injected.
    expect(env.SENTRY_DSN).toBeUndefined();
  });

  test("the undecryptable key is reported (name only), not silently swallowed", async () => {
    const dir = join(workdir, "p");
    const v = await openPersonaVault(dir);
    v.set("GITHUB_TOKEN", "good");
    v.set("SENTRY_DSN", "poisoned");
    v.close();

    corruptRow(dir, "SENTRY_DSN");

    const env: NodeJS.ProcessEnv = {};
    const tracked = new Set<string>();
    const r = await loadVaultIntoEnv(dir, env, tracked);

    // "1 bad row" is distinguishable from "empty vault": the name surfaces.
    expect(r.badKeys).toEqual(["SENTRY_DSN"]);
    expect(r.updated).toContain("GITHUB_TOKEN");
    // A vault with a bad row is NOT the same as a null (unopenable) vault.
    expect(env.GITHUB_TOKEN).toBe("good");
  });
});

describe("retired config.toml mirrors (#452) are never injected", () => {
  // These cases resolve "does config.toml state this setting?", so the HOST's
  // real config file must never be in scope. Point PHANTOMBOT_CONFIG at a
  // path inside the temp workdir and write it per test.
  let priorConfigEnv: string | undefined;
  let hostConfig: string;

  beforeEach(() => {
    priorConfigEnv = process.env.PHANTOMBOT_CONFIG;
    hostConfig = join(workdir, "host-config.toml");
    process.env.PHANTOMBOT_CONFIG = hostConfig;
  });

  afterEach(() => {
    if (priorConfigEnv === undefined) delete process.env.PHANTOMBOT_CONFIG;
    else process.env.PHANTOMBOT_CONFIG = priorConfigEnv;
  });

  test("a mirror row is withheld from env AND evicted, real secrets unaffected", async () => {
    // The bug: pre-#452 wizards wrote model mirrors into ~/.env; #254 vaulted
    // that file wholesale, and #454's drop-list only ran on IMPORT. So an
    // upgraded host kept the rows, loadVaultIntoEnv injected them, and env
    // outranks config.toml in resolveRouting -> `phantombot harness` appeared
    // to save and then silently reverted on the next spawn.
    const dir = join(workdir, "p");
    await mkdir(dir, { recursive: true });
    // The ordinary shape: the old wizard wrote BOTH, so config.toml still
    // holds the setting and dropping the row loses nothing.
    await writeFile(
      join(dir, "config.toml"),
      '[harnesses.pi.routing]\nprimary_model = "new/wanted-model"\n',
    );
    const v = await openPersonaVault(dir);
    v.set("PHANTOMBOT_PRIMARY_MODEL", "stale/old-model");
    v.set("GITHUB_TOKEN", "a-real-secret");
    v.close();

    const env: NodeJS.ProcessEnv = {};
    const tracked = new Set<string>();
    const { updated } = await loadVaultIntoEnv(dir, env, tracked);

    // Withheld: config.toml is left free to win.
    expect(env.PHANTOMBOT_PRIMARY_MODEL).toBeUndefined();
    expect(updated).not.toContain("PHANTOMBOT_PRIMARY_MODEL");
    expect(tracked.has("PHANTOMBOT_PRIMARY_MODEL")).toBe(false);

    // A genuine secret in the same vault still loads — the guard is by name,
    // not a blanket refusal to read a vault that contains a mirror.
    expect(env.GITHUB_TOKEN).toBe("a-real-secret");

    // Evicted from disk, so `vault list` stops advertising a dead setting.
    const after = await openPersonaVault(dir);
    const names = after.list();
    after.close();
    expect(names).not.toContain("PHANTOMBOT_PRIMARY_MODEL");
    expect(names).toContain("GITHUB_TOKEN");
  });

  test("a mirror with NO config.toml home is withheld but NOT deleted", async () => {
    // `phantombot env set PHANTOMBOT_PRIMARY_MODEL …` set the value without
    // ever touching config.toml, and #254 vaulted that file wholesale. On such
    // a host the row is the LAST copy: withholding is what fixes the override,
    // and deleting would drop the persona to a built-in default with nothing
    // left to read the old value from. Eviction is hygiene, so it yields.
    const dir = join(workdir, "p");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.toml"), "[harnesses]\n");
    await writeFile(hostConfig, "[harnesses]\n");
    const v = await openPersonaVault(dir);
    v.set("PHANTOMBOT_PRIMARY_MODEL", "only-copy/model");
    v.close();

    const env: NodeJS.ProcessEnv = {};
    const { updated } = await loadVaultIntoEnv(dir, env, new Set<string>());

    expect(env.PHANTOMBOT_PRIMARY_MODEL).toBeUndefined();
    expect(updated).not.toContain("PHANTOMBOT_PRIMARY_MODEL");

    const after = await openPersonaVault(dir);
    const names = after.list();
    const kept = after.get("PHANTOMBOT_PRIMARY_MODEL");
    after.close();
    expect(names).toContain("PHANTOMBOT_PRIMARY_MODEL");
    expect(kept).toBe("only-copy/model");
  });

  test("the HOST config.toml counts as a home when the persona file is silent", async () => {
    // Precedence mirrors loadConfig: persona layer first, then the host file.
    // A persona that never states the key still resolves to the host's value,
    // so the row there really is a duplicate and may go.
    const dir = join(workdir, "p");
    await mkdir(dir, { recursive: true });
    await writeFile(
      hostConfig,
      '[harnesses.pi.routing]\nprimary_model = "host/model"\n',
    );
    const v = await openPersonaVault(dir);
    v.set("PHANTOMBOT_PRIMARY_MODEL", "stale/old-model");
    v.close();

    await loadVaultIntoEnv(dir, {}, new Set<string>());

    const after = await openPersonaVault(dir);
    const names = after.list();
    after.close();
    expect(names).not.toContain("PHANTOMBOT_PRIMARY_MODEL");
  });

  test("the per-persona suffixed form is dropped too", async () => {
    // `<NAME>_<PERSONA>` beat even the persona's own config file, so it is the
    // worse of the two forms and must not survive on a name-equality check.
    // It is withheld like any other; the row itself is kept, because the file
    // that would own it belongs to some OTHER persona and cannot be resolved
    // from the name alone — unknown lands on the non-destructive side.
    const dir = join(workdir, "p");
    const v = await openPersonaVault(dir);
    v.set("PHANTOMBOT_CODING_MODEL_ROBBIE", "stale/old-coder");
    v.close();

    const env: NodeJS.ProcessEnv = {};
    const { updated } = await loadVaultIntoEnv(dir, env, new Set<string>());

    expect(env.PHANTOMBOT_CODING_MODEL_ROBBIE).toBeUndefined();
    expect(updated).toEqual([]);
  });

  test("withholding survives an eviction that THROWS", async () => {
    // The design claim this pins: withholding is load-bearing and eviction is
    // best-effort, so a refactor that made the skip depend on a successful
    // unset must fail here. Make the vault read-only after the values are
    // written so `unset` raises inside the read path.
    const dir = join(workdir, "p");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "config.toml"),
      '[harnesses.pi.routing]\nprimary_model = "new/wanted-model"\n',
    );
    const v = await openPersonaVault(dir);
    v.set("PHANTOMBOT_PRIMARY_MODEL", "stale/old-model");
    v.set("GITHUB_TOKEN", "a-real-secret");
    v.close();
    // Make exactly the DELETE fail, portably: a BEFORE DELETE trigger that
    // aborts. Read-only file permissions would do it on POSIX but not on
    // Windows, and this suite runs there too — and a trigger is narrower
    // anyway, failing the eviction without disturbing the reads around it.
    const db = new Database(vaultPath(dir));
    db.exec(
      "CREATE TRIGGER no_delete BEFORE DELETE ON secrets " +
        "BEGIN SELECT RAISE(ABORT, 'eviction blocked'); END",
    );
    db.close();

    const env: NodeJS.ProcessEnv = {};
    const tracked = new Set<string>();
    const { updated } = await loadVaultIntoEnv(dir, env, tracked);

    // The eviction really did fail — pins that this case exercises the
    // throwing path and is not silently a happy-path duplicate.
    const after = await openPersonaVault(dir);
    const names = after.list();
    after.close();
    expect(names).toContain("PHANTOMBOT_PRIMARY_MODEL");

    // ...and the row is inert regardless.
    expect(env.PHANTOMBOT_PRIMARY_MODEL).toBeUndefined();
    expect(updated).not.toContain("PHANTOMBOT_PRIMARY_MODEL");
    expect(tracked.has("PHANTOMBOT_PRIMARY_MODEL")).toBe(false);
    // And the failure is contained: real secrets still loaded.
    expect(env.GITHUB_TOKEN).toBe("a-real-secret");
  });

  test("withholding survives a config.toml that cannot be PARSED", async () => {
    // Judging whether a mirror is safe to evict means reading config.toml, and
    // that read throws on anything but a missing file. readAllVaultValues is
    // contracted never to throw — loadVaultIntoEnv is fail-partial — so an
    // escaping parse error would cost the persona EVERY secret in order to
    // deal with a stale model id. Unknown must land non-destructive: withheld,
    // kept, and everything else still loaded.
    const dir = join(workdir, "p");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.toml"), "[harnesses.pi.routing\nprimary_model = \n");
    const v = await openPersonaVault(dir);
    v.set("PHANTOMBOT_PRIMARY_MODEL", "stale/old-model");
    v.set("GITHUB_TOKEN", "a-real-secret");
    v.close();

    const env: NodeJS.ProcessEnv = {};
    const tracked = new Set<string>();
    const { updated } = await loadVaultIntoEnv(dir, env, tracked);

    // The real secret survived: the failure did not take the read path down.
    expect(env.GITHUB_TOKEN).toBe("a-real-secret");
    expect(updated).toContain("GITHUB_TOKEN");

    // The mirror is still inert...
    expect(env.PHANTOMBOT_PRIMARY_MODEL).toBeUndefined();
    expect(tracked.has("PHANTOMBOT_PRIMARY_MODEL")).toBe(false);

    // ...and NOT evicted, because an unreadable config cannot prove there is
    // another copy of the value.
    const after = await openPersonaVault(dir);
    const names = after.list();
    after.close();
    expect(names).toContain("PHANTOMBOT_PRIMARY_MODEL");
  });

  test("a mirror injected by an older build is REMOVED from env on reload", async () => {
    // In-place heal: a daemon upgraded mid-life already has the mirror in
    // process.env and tracked. Phase 1 reconciliation must delete it rather
    // than leave the override standing until the next restart.
    const dir = join(workdir, "p");
    const v = await openPersonaVault(dir);
    v.set("PHANTOMBOT_PRIMARY_MODEL", "stale/old-model");
    v.close();

    const env: NodeJS.ProcessEnv = { PHANTOMBOT_PRIMARY_MODEL: "stale/old-model" };
    const tracked = new Set<string>(["PHANTOMBOT_PRIMARY_MODEL"]);
    const { removed } = await loadVaultIntoEnv(dir, env, tracked);

    expect(env.PHANTOMBOT_PRIMARY_MODEL).toBeUndefined();
    expect(removed).toContain("PHANTOMBOT_PRIMARY_MODEL");
    expect(tracked.has("PHANTOMBOT_PRIMARY_MODEL")).toBe(false);
  });

  test("a SHELL-exported mirror is left alone — the vault is the only target", async () => {
    // Scope guard: #452 kept env-over-config precedence deliberately, so a
    // real `export` stays a working escape hatch. What this PR removes is the
    // vault fabricating that export behind the operator's back.
    const dir = join(workdir, "p");
    const v = await openPersonaVault(dir);
    v.set("GITHUB_TOKEN", "s");
    v.close();

    const env: NodeJS.ProcessEnv = { PHANTOMBOT_PRIMARY_MODEL: "operator/override" };
    await loadVaultIntoEnv(dir, env, new Set<string>());

    expect(env.PHANTOMBOT_PRIMARY_MODEL).toBe("operator/override");
  });
});
