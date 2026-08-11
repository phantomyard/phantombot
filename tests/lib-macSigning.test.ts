/**
 * Tests for the macOS stable-signing module. Everything external (security,
 * codesign, openssl) is injected via a fake CommandRunner and the vault is an
 * in-memory Map, so these run on Linux CI with no Mac. What we pin down:
 *
 *   - isSigningConfigured reflects `security find-certificate`'s exit code
 *   - fixSigning happy path signs + verifies + persists the vault password
 *   - fixSigning rolls BACK fully on failure it caused this run (keychain torn
 *     down, vault password cleared) — a half-made identity is never left behind
 *   - fixSigning that only RE-SIGNS a pre-existing identity never tears down the
 *     working keychain on failure
 *   - resignAfterUpdate runs automatically for everyone: it creates the identity
 *     on the first update when absent, re-signs when present, and fails-safe
 *     (restoring the binary) on any error
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureKeychainInSearchList,
  fixSigning,
  isSigningConfigured,
  parseKeychainSearchList,
  resignAfterUpdate,
  SIGNING_PASSWORD_VAULT_KEY,
  type CommandResult,
  type CommandRunner,
  type SigningSecretStore,
} from "../src/lib/macSigning.ts";

function fakeVault(seed: Record<string, string> = {}): SigningSecretStore & {
  store: Map<string, string>;
} {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    store,
    get: (n) => store.get(n),
    set: (n, v) => void store.set(n, v),
    unset: (n) => void store.delete(n),
  };
}

/**
 * overrides keys are matched most-specific first: `"cmd firstArg"` then `"cmd"`.
 * Everything unmatched defaults to a clean exit 0.
 */
function fakeRunner(overrides: Record<string, Partial<CommandResult>> = {}) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const runner: CommandRunner = {
    async run(cmd, args) {
      calls.push({ cmd, args: [...args] });
      const specific = overrides[`${cmd} ${args[0] ?? ""}`];
      const general = overrides[cmd];
      const o = specific ?? general ?? {};
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        ...o,
      };
    },
  };
  const keys = () => calls.map((c) => `${c.cmd} ${c.args[0] ?? ""}`);
  return { runner, calls, keys };
}

async function tempBinary(content = "ORIGINAL-BINARY"): Promise<{
  home: string;
  binPath: string;
}> {
  const home = await mkdtemp(join(tmpdir(), "pb-sign-home-"));
  const binPath = join(home, "phantombot");
  await writeFile(binPath, content);
  return { home, binPath };
}

describe("isSigningConfigured", () => {
  test("true when find-certificate exits 0", async () => {
    const { runner } = fakeRunner({ "security find-certificate": { exitCode: 0 } });
    expect(await isSigningConfigured(runner, "/x/keychain")).toBe(true);
  });
  test("false when find-certificate exits non-zero", async () => {
    const { runner } = fakeRunner({ "security find-certificate": { exitCode: 1 } });
    expect(await isSigningConfigured(runner, "/x/keychain")).toBe(false);
  });
});

describe("fixSigning", () => {
  test("happy path: creates identity, signs, verifies, persists password", async () => {
    const { home, binPath } = await tempBinary();
    const { runner, keys } = fakeRunner({
      "security find-certificate": { exitCode: 1 }, // not yet configured
    });
    const vault = fakeVault();

    const r = await fixSigning({ runner, vault, binPath, home });

    expect(r.ok).toBe(true);
    // Identity creation happened.
    expect(keys()).toContain("security create-keychain");
    expect(keys()).toContain("openssl req");
    expect(keys()).toContain("security set-key-partition-list");
    // Keychain registered on the user search list so codesign can resolve the
    // identity by name (the crux of the #363 fix).
    expect(keys()).toContain("security list-keychains");
    // Signed with the stable identity + verified.
    expect(keys()).toContain("codesign --force");
    expect(keys()).toContain("codesign --verify");
    // Password persisted for the headless update path.
    expect(vault.store.get(SIGNING_PASSWORD_VAULT_KEY)).toBeTruthy();
    // Backup cleaned up on success.
    expect(await Bun.file(`${binPath}.presign.bak`).exists()).toBe(false);
  });

  test("rollback on codesign failure it caused this run: tears down marker", async () => {
    const { home, binPath } = await tempBinary();
    const { runner, keys } = fakeRunner({
      "security find-certificate": { exitCode: 1 },
      "codesign --force": { exitCode: 1, stderr: "the code signing subsystem barfed" },
    });
    const vault = fakeVault();

    const r = await fixSigning({ runner, vault, binPath, home });

    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe("codesign");
    // Keychain we created this run was deleted during rollback.
    expect(keys().filter((k) => k === "security delete-keychain").length).toBeGreaterThanOrEqual(1);
    // Vault password we wrote this run was cleared — no half-made opt-in marker.
    expect(vault.store.has(SIGNING_PASSWORD_VAULT_KEY)).toBe(false);
    // Binary restored to its original bytes.
    expect(await readFile(binPath, "utf8")).toBe("ORIGINAL-BINARY");
  });

  test("rollback on a post-create identity step failure tears down the partial keychain", async () => {
    // create-keychain succeeds but a LATER step (set-key-partition-list) fails.
    // The keychain now exists on disk, so rollback MUST delete it — otherwise a
    // cert-bearing keychain would survive next to a cleared vault password and
    // permanently break automatic repair on every subsequent update.
    const { home, binPath } = await tempBinary();
    const { runner, keys } = fakeRunner({
      "security find-certificate": { exitCode: 1 }, // not yet configured
      "security set-key-partition-list": { exitCode: 1, stderr: "partition boom" },
    });
    const vault = fakeVault();

    const r = await fixSigning({ runner, vault, binPath, home });

    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe("set-key-partition-list");
    // The partially-created keychain was torn down during rollback (the initial
    // idempotent delete + the rollback delete → at least two delete calls).
    expect(keys().filter((k) => k === "security delete-keychain").length).toBeGreaterThanOrEqual(2);
    // Vault password we wrote this run was cleared — never leave a password
    // stranded against an orphaned keychain.
    expect(vault.store.has(SIGNING_PASSWORD_VAULT_KEY)).toBe(false);
    // Never signed the binary since identity creation failed → bytes untouched.
    expect(await readFile(binPath, "utf8")).toBe("ORIGINAL-BINARY");
  });

  test("re-sign of a pre-existing opt-in: failure does NOT tear down the keychain", async () => {
    const { home, binPath } = await tempBinary();
    const { runner, keys } = fakeRunner({
      "security find-certificate": { exitCode: 0 }, // already configured
      "codesign --force": { exitCode: 1, stderr: "nope" },
    });
    // Password already present from the prior opt-in.
    const vault = fakeVault({ [SIGNING_PASSWORD_VAULT_KEY]: "existing-pw" });

    const r = await fixSigning({ runner, vault, binPath, home });

    expect(r.ok).toBe(false);
    // Never created a keychain (already configured) → never deleted one.
    expect(keys()).not.toContain("security create-keychain");
    expect(keys()).not.toContain("security delete-keychain");
    // Existing opt-in preserved.
    expect(vault.store.get(SIGNING_PASSWORD_VAULT_KEY)).toBe("existing-pw");
    // Binary still intact.
    expect(await readFile(binPath, "utf8")).toBe("ORIGINAL-BINARY");
  });

  test("rollback restores the prior keychain search list on codesign failure", async () => {
    const { home, binPath } = await tempBinary();
    const prior = "/Users/x/Library/Keychains/login.keychain-db";
    const { runner, calls } = fakeRunner({
      "security find-certificate": { exitCode: 1 },
      "security list-keychains": { stdout: `    "${prior}"\n` },
      "codesign --force": { exitCode: 1, stderr: "nope" },
    });
    const vault = fakeVault();

    const r = await fixSigning({ runner, vault, binPath, home });

    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe("codesign");
    // The LAST list-keychains -s call restores exactly the prior list (no
    // dangling entry for the keychain we tore down).
    const setCalls = calls.filter(
      (c) => c.cmd === "security" && c.args.includes("-s"),
    );
    expect(setCalls.at(-1)?.args).toEqual([
      "list-keychains",
      "-d",
      "user",
      "-s",
      prior,
    ]);
  });

  test("rollback on failed exec-check after signing", async () => {
    const { home, binPath } = await tempBinary();
    const { runner } = fakeRunner({
      "security find-certificate": { exitCode: 1 },
      // sign + codesign --verify pass, but the binary won't run.
      [`${binPath} --version`]: { exitCode: 1 },
    });
    const vault = fakeVault();

    const r = await fixSigning({ runner, vault, binPath, home });

    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe("exec-check");
    expect(vault.store.has(SIGNING_PASSWORD_VAULT_KEY)).toBe(false);
  });
});

describe("parseKeychainSearchList", () => {
  test("strips indentation and surrounding quotes", () => {
    const out =
      '    "/Users/x/Library/Keychains/login.keychain-db"\n' +
      '    "/Library/Keychains/System.keychain"\n';
    expect(parseKeychainSearchList(out)).toEqual([
      "/Users/x/Library/Keychains/login.keychain-db",
      "/Library/Keychains/System.keychain",
    ]);
  });
  test("ignores blank lines", () => {
    expect(parseKeychainSearchList('\n   "/a/b.keychain"\n\n')).toEqual([
      "/a/b.keychain",
    ]);
  });
});

describe("ensureKeychainInSearchList", () => {
  const kc = "/home/u/Library/Keychains/phantombot-signing.keychain";

  test("adds the keychain when absent, preserving the prior list", async () => {
    const { runner, calls } = fakeRunner({
      "security list-keychains": {
        stdout: '    "/home/u/Library/Keychains/login.keychain-db"\n',
      },
    });
    const r = await ensureKeychainInSearchList({
      run: (c, a) => runner.run(c, a),
      keychainPath: kc,
    });
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ added: true });
    // The set call appended our keychain AFTER the existing entries.
    const setCall = calls.find(
      (c) => c.cmd === "security" && c.args.includes("-s"),
    );
    expect(setCall?.args).toEqual([
      "list-keychains",
      "-d",
      "user",
      "-s",
      "/home/u/Library/Keychains/login.keychain-db",
      kc,
    ]);
  });

  test("is a no-op when already present (tolerates the -db suffix)", async () => {
    // macOS reports the on-disk `.keychain-db` even though we pass `.keychain`.
    const { runner, calls } = fakeRunner({
      "security list-keychains": {
        stdout:
          '    "/home/u/Library/Keychains/login.keychain-db"\n' +
          `    "${kc}-db"\n`,
      },
    });
    const r = await ensureKeychainInSearchList({
      run: (c, a) => runner.run(c, a),
      keychainPath: kc,
    });
    expect(r).toEqual({ ok: true, added: false });
    // No mutating `-s` call was issued.
    expect(calls.some((c) => c.args.includes("-s"))).toBe(false);
  });

  test("surfaces a read failure without mutating", async () => {
    const { runner, calls } = fakeRunner({
      "security list-keychains": { exitCode: 1 },
    });
    const r = await ensureKeychainInSearchList({
      run: (c, a) => runner.run(c, a),
      keychainPath: kc,
    });
    expect(r).toEqual({ ok: false, failedStep: "list-keychains-read" });
    expect(calls.some((c) => c.args.includes("-s"))).toBe(false);
  });
});

describe("resignAfterUpdate (automatic for everyone — no opt-in)", () => {
  test("creates the identity on the first update when absent, then signs", async () => {
    const { home, binPath } = await tempBinary();
    const { runner, keys } = fakeRunner({
      "security find-certificate": { exitCode: 1 }, // no identity yet
    });
    const vault = fakeVault();

    const r = await resignAfterUpdate({ runner, vault, binPath, home });

    expect(r.status).toBe("resigned");
    // The identity was created automatically — no prior fix-signing needed.
    expect(keys()).toContain("security create-keychain");
    expect(keys()).toContain("codesign --force");
    // Password persisted so future headless updates can re-sign silently.
    expect(vault.store.get(SIGNING_PASSWORD_VAULT_KEY)).toBeTruthy();
    expect(await Bun.file(`${binPath}.presign.bak`).exists()).toBe(false);
  });

  test("re-signs against the existing identity on subsequent updates", async () => {
    const { home, binPath } = await tempBinary();
    const { runner, keys } = fakeRunner({
      "security find-certificate": { exitCode: 0 }, // identity already present
    });
    const vault = fakeVault({ [SIGNING_PASSWORD_VAULT_KEY]: "pw" });

    const r = await resignAfterUpdate({ runner, vault, binPath, home });

    expect(r.status).toBe("resigned");
    // Doesn't recreate the keychain when one already exists.
    expect(keys()).not.toContain("security create-keychain");
    expect(keys()).toContain("codesign --force");
    expect(await Bun.file(`${binPath}.presign.bak`).exists()).toBe(false);
  });

  test("fails-safe (restores binary) when codesign fails", async () => {
    const { home, binPath } = await tempBinary();
    const { runner } = fakeRunner({
      "security find-certificate": { exitCode: 0 },
      "codesign --force": { exitCode: 1, stderr: "boom" },
    });
    const vault = fakeVault({ [SIGNING_PASSWORD_VAULT_KEY]: "pw" });

    const r = await resignAfterUpdate({ runner, vault, binPath, home });

    expect(r.status).toBe("failed");
    // The swapped binary is left working (ad-hoc), never broken.
    expect(await readFile(binPath, "utf8")).toBe("ORIGINAL-BINARY");
  });
});
