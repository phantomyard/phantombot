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
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateSecretKey } from "nostr-tools/pure";

import {
  _resetVaultTrackingForTesting,
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
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
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
