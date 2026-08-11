/**
 * macOS stable code-signing for the self-updating phantombot binary.
 *
 * THE PROBLEM. On macOS, TCC (Privacy & Security) pins every permission grant
 * — Full Disk Access, Documents, Desktop, Downloads, AppleEvents — to the
 * exact code-signing identity (ultimately the cdhash) of the binary that was
 * granted. phantombot ships ad-hoc / linker-signed (`Identifier=a.out`, no
 * stable designated requirement), and it AUTO-UPDATES ITS OWN BINARY. Each
 * update rewrites the file → new cdhash → every stored grant stops matching →
 * macOS re-prompts for every protected resource, forever. That is the endless
 * "allow access to your home folder" nagging.
 *
 * THE FIX. Give the binary a STABLE self-signed code-signing identity, so its
 * designated requirement stops changing across updates. Grant once against
 * that identity and TCC never asks again — even though the bytes change on
 * every update. This module creates that identity and applies it.
 *
 * SAFETY IS THE WHOLE POINT (see the /update path). phantombot's trademark is
 * "updates never break." So:
 *
 *   - The signing identity lives in a DEDICATED throwaway keychain
 *     (`phantombot-signing.keychain`) whose password WE generate and stash in
 *     the vault. The user's LOGIN keychain — the one with the password nobody
 *     remembers — is NEVER touched. codesign can therefore run fully headless;
 *     the OS never has a reason to pop the dreaded "keychain password" dialog.
 *
 *   - Every mutating operation is TRANSACTIONAL. `fixSigning` backs up the
 *     binary before signing and rolls it back on any failure; if it created
 *     the keychain/cert this run and then failed, it tears BOTH down and clears
 *     the vault password, because the keychain's existence is the opt-in marker
 *     the update path keys off — a half-created marker would make the next
 *     update try to maintain a broken identity. Roll back everything this run
 *     created, or nothing.
 *
 *   - Every external command runs under a TIMEOUT, so codesign can never hang a
 *     headless update waiting on a prompt; a timeout is treated as failure and
 *     triggers rollback.
 *
 *   - `resignAfterUpdate` (called from /update) is GATED on the opt-in marker
 *     already existing and is best-effort: on any failure it restores the
 *     pre-sign binary and returns quietly, degrading to EXACTLY today's
 *     behaviour (working binary, ad-hoc signature, still nags) — never worse.
 *     Users who never opted in run zero new code.
 *
 * This module is macOS-only in effect; callers guard on platform. It shells out
 * to `security`, `codesign`, `openssl`, and `spctl` through an injectable
 * CommandRunner so the logic is unit-testable from Linux CI without a Mac.
 */

import { randomBytes } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Common Name of the self-signed code-signing certificate. */
export const SIGNING_CERT_CN = "phantombot-codesign";

/**
 * `--identifier` handed to codesign. Fixing this (rather than letting codesign
 * derive `a.out` from the Mach-O) is half of what makes the designated
 * requirement stable across binary swaps; the cert identity is the other half.
 */
export const SIGNING_BUNDLE_ID = "dev.phantombot";

/** Basename of the dedicated signing keychain (never the login keychain). */
export const SIGNING_KEYCHAIN_BASENAME = "phantombot-signing.keychain";

/**
 * Vault key under which the generated keychain password is stored so the
 * headless /update path can unlock the keychain and re-sign silently.
 */
export const SIGNING_PASSWORD_VAULT_KEY = "MACOS_SIGNING_KEYCHAIN_PASSWORD";

/** Default per-command timeout. codesign/security are fast; a stall is a bug. */
const DEFAULT_TIMEOUT_MS = 60_000;

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the process was killed by the timeout rather than exiting. */
  timedOut: boolean;
}

export interface CommandRunner {
  run(
    cmd: string,
    args: readonly string[],
    opts?: { timeoutMs?: number },
  ): Promise<CommandResult>;
}

/** Production runner: Bun.spawn with a hard timeout. Never throws. */
export class BunCommandRunner implements CommandRunner {
  async run(
    cmd: string,
    args: readonly string[],
    opts: { timeoutMs?: number } = {},
  ): Promise<CommandResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
      const proc = Bun.spawn([cmd, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        // Bun kills the process when the timeout elapses; we detect that
        // below via signalCode/exitCode and surface timedOut=true.
        timeout: timeoutMs,
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const timedOut = proc.signalCode === "SIGTERM" || proc.killed;
      return { exitCode, stdout, stderr, timedOut };
    } catch (e) {
      // Command not found (no `codesign` on Linux) or spawn failure — surface
      // as a non-zero result rather than throwing, so callers stay linear.
      return {
        exitCode: 127,
        stdout: "",
        stderr: (e as Error).message,
        timedOut: false,
      };
    }
  }
}

/** Minimal slice of the vault this module needs. The real Vault satisfies it. */
export interface SigningSecretStore {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  unset(name: string): void;
}

/** Absolute path of the dedicated signing keychain for the given home dir. */
export function signingKeychainPath(home: string = homedir()): string {
  return join(home, "Library", "Keychains", SIGNING_KEYCHAIN_BASENAME);
}

/**
 * True when the opt-in marker exists: the dedicated keychain holds our
 * code-signing certificate. This is the single gate the /update path checks —
 * absent, and the update path runs zero new code.
 */
export async function isSigningConfigured(
  runner: CommandRunner,
  keychainPath: string = signingKeychainPath(),
): Promise<boolean> {
  const r = await runner.run("security", [
    "find-certificate",
    "-c",
    SIGNING_CERT_CN,
    keychainPath,
  ]);
  return r.exitCode === 0;
}

export interface FixSigningOptions {
  runner: CommandRunner;
  vault: SigningSecretStore;
  /** The binary to sign. Defaults to process.execPath. */
  binPath: string;
  home?: string;
  timeoutMs?: number;
}

export interface FixSigningResult {
  ok: boolean;
  /** Human-readable summary of what happened, safe to print (no secrets). */
  message: string;
  /** Set on failure: the concrete step that failed, for the manual hint. */
  failedStep?: string;
}

/**
 * Create the stable signing identity (if absent) and sign `binPath` with it.
 *
 * Transactional: on any failure, restores the binary and — if THIS call created
 * the keychain/cert — tears them down and clears the vault password, returning
 * the machine to exactly its prior state (ad-hoc signed, still working). Never
 * throws. Never touches the login keychain.
 */
export async function fixSigning(
  opts: FixSigningOptions,
): Promise<FixSigningResult> {
  const { runner, vault } = opts;
  const home = opts.home ?? homedir();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const keychainPath = signingKeychainPath(home);
  const binPath = opts.binPath;
  const backupPath = `${binPath}.presign.bak`;
  const run = (cmd: string, args: readonly string[]) =>
    runner.run(cmd, args, { timeoutMs });

  // Track what THIS invocation creates, so rollback only tears down our own
  // work and never a keychain the user already opted into on a prior run.
  const alreadyConfigured = await isSigningConfigured(runner, keychainPath);
  let createdKeychain = false;
  let wroteVaultPassword = false;
  let backedUp = false;

  const rollback = async (): Promise<void> => {
    // Restore the binary first — it's the thing that must never end up broken.
    if (backedUp) {
      try {
        await copyFile(backupPath, binPath);
      } catch {
        /* best-effort: the backup is still on disk for manual restore */
      }
    }
    // Only tear down keychain/cert + vault password if we created them here.
    // Tearing down a pre-existing opt-in would break a working install.
    if (createdKeychain) {
      await run("security", ["delete-keychain", keychainPath]);
    }
    if (wroteVaultPassword && !alreadyConfigured) {
      try {
        vault.unset(SIGNING_PASSWORD_VAULT_KEY);
      } catch {
        /* ignore */
      }
    }
  };

  try {
    // 1. Ensure a keychain password exists (generate + persist if not).
    let password = vault.get(SIGNING_PASSWORD_VAULT_KEY);
    if (!password) {
      password = randomBytes(24).toString("hex");
      vault.set(SIGNING_PASSWORD_VAULT_KEY, password);
      wroteVaultPassword = true;
    }

    // 2. Ensure the dedicated keychain + certificate exist.
    if (!alreadyConfigured) {
      const created = await createSigningIdentity({
        run,
        keychainPath,
        password,
      });
      if (!created.ok) {
        await rollback();
        return {
          ok: false,
          message: `Couldn't create the signing identity (${created.failedStep}). ` +
            `No changes were left behind — phantombot still works exactly as before.`,
          failedStep: created.failedStep,
        };
      }
      createdKeychain = true;
    } else {
      // Keychain exists from a prior opt-in — just make sure it's unlocked so
      // codesign can read the key headlessly.
      await run("security", ["unlock-keychain", "-p", password, keychainPath]);
    }

    // 3. Back up the binary, then sign it.
    await copyFile(binPath, backupPath);
    backedUp = true;

    const sign = await run("codesign", [
      "--force",
      "--sign",
      SIGNING_CERT_CN,
      "--identifier",
      SIGNING_BUNDLE_ID,
      "--keychain",
      keychainPath,
      "--timestamp=none",
      binPath,
    ]);
    if (sign.exitCode !== 0) {
      await rollback();
      return {
        ok: false,
        message: `codesign failed${sign.timedOut ? " (timed out)" : ""}: ` +
          `${firstLine(sign.stderr)}. Rolled back — phantombot still works as before.`,
        failedStep: "codesign",
      };
    }

    // 4. Verify: signature is valid AND the binary still executes.
    const verified = await verifySignedBinary({ run, binPath });
    if (!verified.ok) {
      await rollback();
      return {
        ok: false,
        message: `Signature verification failed (${verified.failedStep}). ` +
          `Rolled back — phantombot still works as before.`,
        failedStep: verified.failedStep,
      };
    }

    // Success — drop the now-redundant backup.
    await rm(backupPath, { force: true });
    return {
      ok: true,
      message:
        "Stable code-signing identity installed and applied. Grant Full Disk " +
        "Access once in System Settings → Privacy & Security and macOS will " +
        "never nag again, across every future update.",
    };
  } catch (e) {
    // Any unexpected throw — roll back to the last known-good state.
    await rollback();
    return {
      ok: false,
      message: `Unexpected error while fixing signing: ${(e as Error).message}. ` +
        `Rolled back — phantombot still works as before.`,
      failedStep: "unexpected",
    };
  }
}

export interface ResignAfterUpdateOptions {
  runner: CommandRunner;
  vault: SigningSecretStore;
  binPath: string;
  home?: string;
  timeoutMs?: number;
}

export type ResignAfterUpdateResult =
  | { status: "skipped"; reason: string }
  | { status: "resigned" }
  | { status: "failed"; reason: string };

/**
 * Best-effort re-sign after a binary swap, for the /update path.
 *
 * GATED on the opt-in marker: if the signing keychain/cert isn't present, this
 * is a no-op (`skipped`) — users who never opted in are untouched. When opted
 * in, it backs up the freshly-swapped binary, re-signs with the stable
 * identity, verifies, and on ANY failure restores the backup and returns
 * `failed` — degrading to exactly today's behaviour (working binary, no stable
 * signature). Never throws.
 */
export async function resignAfterUpdate(
  opts: ResignAfterUpdateOptions,
): Promise<ResignAfterUpdateResult> {
  const { runner, vault } = opts;
  const home = opts.home ?? homedir();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const keychainPath = signingKeychainPath(home);
  const binPath = opts.binPath;
  const backupPath = `${binPath}.presign.bak`;
  const run = (cmd: string, args: readonly string[]) =>
    runner.run(cmd, args, { timeoutMs });

  try {
    if (!(await isSigningConfigured(runner, keychainPath))) {
      return { status: "skipped", reason: "no stable signing identity configured" };
    }
    const password = vault.get(SIGNING_PASSWORD_VAULT_KEY);
    if (!password) {
      // Marker exists but password is gone — we can't unlock headlessly. Don't
      // guess or prompt in a headless update; leave the swapped binary as-is.
      return {
        status: "failed",
        reason: "signing keychain password missing from vault; run 'phantombot fix-signing'",
      };
    }

    const unlock = await run("security", [
      "unlock-keychain",
      "-p",
      password,
      keychainPath,
    ]);
    if (unlock.exitCode !== 0) {
      return { status: "failed", reason: `could not unlock signing keychain: ${firstLine(unlock.stderr)}` };
    }

    await copyFile(binPath, backupPath);
    const sign = await run("codesign", [
      "--force",
      "--sign",
      SIGNING_CERT_CN,
      "--identifier",
      SIGNING_BUNDLE_ID,
      "--keychain",
      keychainPath,
      "--timestamp=none",
      binPath,
    ]);
    if (sign.exitCode !== 0) {
      await restore(backupPath, binPath);
      return {
        status: "failed",
        reason: `codesign failed${sign.timedOut ? " (timed out)" : ""}: ${firstLine(sign.stderr)}`,
      };
    }

    const verified = await verifySignedBinary({ run, binPath });
    if (!verified.ok) {
      await restore(backupPath, binPath);
      return { status: "failed", reason: `verification failed (${verified.failedStep})` };
    }

    await rm(backupPath, { force: true });
    return { status: "resigned" };
  } catch (e) {
    // Try to leave a working binary behind even on an unexpected throw.
    await restore(backupPath, binPath);
    return { status: "failed", reason: (e as Error).message };
  }
}

/**
 * Create the dedicated keychain and a self-signed code-signing certificate
 * inside it, with the key ACL + partition list set so codesign never prompts.
 *
 * We generate the cert with openssl (headless; the macOS Certificate Assistant
 * is GUI-only) with the codeSigning extendedKeyUsage, wrap it in a PKCS#12, and
 * import it into the dedicated keychain granting /usr/bin/codesign access.
 */
async function createSigningIdentity(args: {
  run: (cmd: string, a: readonly string[]) => Promise<CommandResult>;
  keychainPath: string;
  password: string;
}): Promise<{ ok: true } | { ok: false; failedStep: string }> {
  const { run, keychainPath, password } = args;

  // Fresh keychain. Deleting first makes create idempotent if a stale,
  // cert-less keychain was left around (isSigningConfigured would be false).
  await run("security", ["delete-keychain", keychainPath]);
  const create = await run("security", [
    "create-keychain",
    "-p",
    password,
    keychainPath,
  ]);
  if (create.exitCode !== 0) return { ok: false, failedStep: "create-keychain" };

  // No auto-lock / no lock-on-sleep so a long-lived service can always re-sign.
  await run("security", ["set-keychain-settings", keychainPath]);
  const unlock = await run("security", ["unlock-keychain", "-p", password, keychainPath]);
  if (unlock.exitCode !== 0) return { ok: false, failedStep: "unlock-keychain" };

  // Generate key + self-signed codesigning cert + p12 in a temp dir we scrub.
  const workdir = await mkdtemp(join(tmpdir(), "phantombot-signing-"));
  const keyPem = join(workdir, "key.pem");
  const certPem = join(workdir, "cert.pem");
  const p12 = join(workdir, "identity.p12");
  try {
    const req = await run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      keyPem,
      "-out",
      certPem,
      "-days",
      "3650",
      "-nodes",
      "-subj",
      `/CN=${SIGNING_CERT_CN}`,
      "-addext",
      "basicConstraints=critical,CA:false",
      "-addext",
      "keyUsage=critical,digitalSignature",
      "-addext",
      "extendedKeyUsage=critical,codeSigning",
    ]);
    if (req.exitCode !== 0) return { ok: false, failedStep: "openssl-req" };

    const pk = await run("openssl", [
      "pkcs12",
      "-export",
      "-inkey",
      keyPem,
      "-in",
      certPem,
      "-out",
      p12,
      "-passout",
      `pass:${password}`,
      "-name",
      SIGNING_CERT_CN,
    ]);
    if (pk.exitCode !== 0) return { ok: false, failedStep: "openssl-pkcs12" };

    // Import, granting codesign non-prompting access to the private key.
    const imp = await run("security", [
      "import",
      p12,
      "-k",
      keychainPath,
      "-P",
      password,
      "-T",
      "/usr/bin/codesign",
      "-A",
    ]);
    if (imp.exitCode !== 0) return { ok: false, failedStep: "import" };

    // Partition list is the crucial headless step: without it, the first
    // codesign against this key pops the "codesign wants to use a key" dialog
    // that would hang a service. This authorises apple/codesign tooling.
    const part = await run("security", [
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:,codesign:",
      "-s",
      "-k",
      password,
      keychainPath,
    ]);
    if (part.exitCode !== 0) return { ok: false, failedStep: "set-key-partition-list" };

    return { ok: true };
  } finally {
    // Scrub the private key material regardless of outcome.
    await rm(workdir, { recursive: true, force: true });
  }
}

async function verifySignedBinary(args: {
  run: (cmd: string, a: readonly string[]) => Promise<CommandResult>;
  binPath: string;
}): Promise<{ ok: true } | { ok: false; failedStep: string }> {
  const { run, binPath } = args;
  const verify = await run("codesign", ["--verify", "--strict", binPath]);
  if (verify.exitCode !== 0) return { ok: false, failedStep: "codesign-verify" };
  // Exec check: a valid signature on a binary that won't run is useless. Cheap
  // and decisive — if the swapped+signed binary can't print its version, the
  // swap is bad and we must roll back.
  const exec = await run(binPath, ["--version"]);
  if (exec.exitCode !== 0) return { ok: false, failedStep: "exec-check" };
  return { ok: true };
}

async function restore(backupPath: string, binPath: string): Promise<void> {
  try {
    await copyFile(backupPath, binPath);
    await rm(backupPath, { force: true });
  } catch {
    /* best-effort: backup remains on disk for manual restore */
  }
}

function firstLine(s: string): string {
  return (s.split("\n").find((l) => l.trim().length > 0) ?? "").trim();
}
