/**
 * Tests for the macOS stable-signing module. Everything external (security,
 * codesign, openssl) is injected via a fake CommandRunner and the vault is an
 * in-memory Map, so these run on Linux CI with no Mac. What we pin down:
 *
 *   - isSigningConfigured reflects `security find-certificate`'s exit code
 *   - fixSigning happy path signs + verifies + persists the vault password
 *   - fixSigning rolls BACK fully on failure it caused this run (keychain torn
 *     down, vault password cleared) — the opt-in marker is never left half-made
 *   - fixSigning that only RE-SIGNS a pre-existing opt-in never tears down the
 *     working keychain on failure
 *   - resignAfterUpdate is a no-op ("skipped") unless the marker exists
 *   - resignAfterUpdate re-signs on the happy path and fails-safe otherwise
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fixSigning,
  isSigningConfigured,
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

describe("resignAfterUpdate", () => {
  test("skipped when not opted in — no codesign runs", async () => {
    const { home, binPath } = await tempBinary();
    const { runner, keys } = fakeRunner({
      "security find-certificate": { exitCode: 1 },
    });
    const vault = fakeVault();

    const r = await resignAfterUpdate({ runner, vault, binPath, home });

    expect(r.status).toBe("skipped");
    expect(keys()).not.toContain("codesign --force");
  });

  test("resigns on the happy path when opted in", async () => {
    const { home, binPath } = await tempBinary();
    const { runner, keys } = fakeRunner({
      "security find-certificate": { exitCode: 0 },
    });
    const vault = fakeVault({ [SIGNING_PASSWORD_VAULT_KEY]: "pw" });

    const r = await resignAfterUpdate({ runner, vault, binPath, home });

    expect(r.status).toBe("resigned");
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
    expect(await readFile(binPath, "utf8")).toBe("ORIGINAL-BINARY");
  });

  test("fails when opted in but password is missing from the vault", async () => {
    const { home, binPath } = await tempBinary();
    const { runner, keys } = fakeRunner({
      "security find-certificate": { exitCode: 0 },
    });
    const vault = fakeVault(); // marker exists but no password

    const r = await resignAfterUpdate({ runner, vault, binPath, home });

    expect(r.status).toBe("failed");
    // Never attempted to unlock/sign without the password.
    expect(keys()).not.toContain("codesign --force");
  });
});
