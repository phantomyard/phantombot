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
 *     The dedicated keychain IS added to the USER keychain search list (never
 *     the login keychain, and never the system domain) because codesign
 *     resolves the signing identity by name through that list rather than the
 *     `--keychain` argument; on any failure the prior search list is restored.
 *
 *   - Every mutating operation is TRANSACTIONAL. `fixSigning` backs up the
 *     binary before signing and rolls it back on any failure; if it created
 *     the keychain/cert this run and then failed, it tears BOTH down and clears
 *     the vault password, so a half-created identity is never left behind for
 *     the next update to trip over. Roll back everything this run created, or
 *     nothing.
 *
 *   - Every external command runs under a TIMEOUT, so codesign can never hang a
 *     headless update waiting on a prompt; a timeout is treated as failure and
 *     triggers rollback.
 *
 *   - `resignAfterUpdate` (called from /update) runs AUTOMATICALLY on every
 *     macOS update — there is NO opt-in. So the fix reaches everyone, including
 *     the installs we never hear about: those are exactly the scared external
 *     users the nagging frightens most. It ensures the stable identity exists
 *     (creating it on the first update if absent), then re-signs the freshly
 *     swapped binary. It is best-effort: on ANY failure it restores the
 *     pre-sign binary (tearing down anything it created this run) and returns
 *     quietly, degrading to EXACTLY today's behaviour (working binary, ad-hoc
 *     signature, still nags) — never worse. The FAIL-SAFE, not gating, is what
 *     guarantees an update can never break.
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

/**
 * Absolute path to macOS's system OpenSSL (LibreSSL). We MUST pin this rather
 * than PATH-resolve bare `openssl`: phantombot's launchd PATH puts
 * `/opt/homebrew/bin` ahead of `/usr/bin`, so a bare `openssl` resolves to
 * Homebrew's OpenSSL 3.x. Its `pkcs12 -export` writes the PKCS#12 MAC/PBE with
 * modern algorithms that Apple's `security import` (LibreSSL-era) rejects with
 * `MAC verification failed during PKCS12 import` — which failed EVERY macOS
 * /update re-sign at the import step. `/usr/bin/openssl` is always present on
 * macOS and produces import-compatible p12s. (`-legacy` is NOT the fix: that
 * flag is an OpenSSL-3-ism and breaks on LibreSSL.)
 */
export const OPENSSL_BIN = "/usr/bin/openssl";

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
 * True when the stable signing identity already exists: the dedicated keychain
 * holds our code-signing certificate. `fixSigning` uses this to decide whether
 * to CREATE the identity (first update on a machine) or just re-sign against an
 * existing one — not as an opt-in gate; signing runs for everyone.
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

/**
 * Parse `security list-keychains` output into bare paths. Each line is a
 * whitespace-indented, double-quoted path; strip both.
 */
export function parseKeychainSearchList(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/^"(.*)"$/, "$1"));
}

/**
 * Ensure the dedicated signing keychain is on the USER keychain search list, so
 * `codesign --sign <name>` can resolve the identity (it searches the list, not
 * the `--keychain` path). Idempotent: no-op if already present; otherwise
 * appends and returns the prior list so a failed run can restore it exactly.
 *
 * Matching tolerates macOS's `-db` suffix: `create-keychain foo.keychain`
 * materialises `foo.keychain-db` on disk and the search list reports the real
 * path, so a naive exact compare would re-append a duplicate every run.
 */
export async function ensureKeychainInSearchList(args: {
  run: (cmd: string, a: readonly string[]) => Promise<CommandResult>;
  keychainPath: string;
}): Promise<
  | { ok: true; added: false }
  | { ok: true; added: true; priorList: string[] }
  | { ok: false; failedStep: string }
> {
  const { run, keychainPath } = args;
  const read = await run("security", ["list-keychains", "-d", "user"]);
  if (read.exitCode !== 0)
    return { ok: false, failedStep: "list-keychains-read" };
  const priorList = parseKeychainSearchList(read.stdout);
  const norm = (p: string) => p.replace(/-db$/, "");
  const target = norm(keychainPath);
  if (priorList.some((p) => norm(p) === target))
    return { ok: true, added: false };
  const set = await run("security", [
    "list-keychains",
    "-d",
    "user",
    "-s",
    ...priorList,
    keychainPath,
  ]);
  if (set.exitCode !== 0)
    return { ok: false, failedStep: "list-keychains-set" };
  return { ok: true, added: true, priorList };
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
  // work and never a keychain a prior successful run already established.
  const alreadyConfigured = await isSigningConfigured(runner, keychainPath);
  let createdKeychain = false;
  let wroteVaultPassword = false;
  let backedUp = false;
  // If we add our keychain to the user search list this run, remember the prior
  // list so rollback restores it exactly (roll back everything, or nothing).
  let priorSearchList: string[] | null = null;

  const rollback = async (): Promise<void> => {
    // Restore the binary first — it's the thing that must never end up broken.
    if (backedUp) {
      try {
        await copyFile(backupPath, binPath);
      } catch {
        /* best-effort: the backup is still on disk for manual restore */
      }
    }
    // Restore the user keychain search list if we changed it this run, before
    // deleting the keychain (so we never leave a dangling search-list entry).
    if (priorSearchList) {
      await run("security", [
        "list-keychains",
        "-d",
        "user",
        "-s",
        ...priorSearchList,
      ]);
    }
    // Only tear down keychain/cert + vault password if we created them here.
    // Tearing down a pre-existing identity would break a working install.
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
      // Mark the keychain for teardown the moment `create-keychain` succeeded,
      // even if a later identity step failed — otherwise rollback would leave a
      // partial keychain behind while clearing the vault password, which breaks
      // automatic repair on every subsequent update.
      createdKeychain = created.keychainCreated;
      if (!created.ok) {
        await rollback();
        return {
          ok: false,
          message: `Couldn't create the signing identity (${created.failedStep}). ` +
            `No changes were left behind — phantombot still works exactly as before.`,
          failedStep: created.failedStep,
        };
      }
    } else {
      // Keychain exists from a prior update/run — just make sure it's unlocked
      // so codesign can read the key headlessly.
      await run("security", ["unlock-keychain", "-p", password, keychainPath]);
    }

    // 3. Make the identity resolvable by codesign. codesign looks up
    //    `--sign <name>` through the USER keychain search list; the
    //    `--keychain <path>` argument does NOT scope that lookup. A dedicated
    //    keychain that isn't in the search list yields "no identity found",
    //    which stalls headless and rolls back. Add ours if absent (idempotent).
    const searchList = await ensureKeychainInSearchList({ run, keychainPath });
    if (!searchList.ok) {
      await rollback();
      return {
        ok: false,
        message: `Couldn't register the signing keychain (${searchList.failedStep}). ` +
          `Rolled back — phantombot still works as before.`,
        failedStep: searchList.failedStep,
      };
    }
    if (searchList.added) priorSearchList = searchList.priorList;

    // 4. Back up the binary, then sign it.
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

    // 5. Verify: signature is valid AND the binary still executes.
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
  | { status: "resigned" }
  | { status: "failed"; reason: string };

/**
 * Automatic re-sign after a binary swap, for the /update path — runs for
 * EVERYONE on macOS, with no opt-in.
 *
 * This is a thin adapter over `fixSigning`, which already does the complete
 * job idempotently and fail-safely: ensure the stable identity exists (create
 * it on the first update if absent), back up the freshly-swapped binary,
 * re-sign it with the stable identity, verify signature + exec, and on ANY
 * failure roll everything this run created back — leaving a working binary with
 * exactly today's behaviour (ad-hoc signature, still nags). Never throws.
 *
 * The result is flattened to `resigned` / `failed` so the update path can keep
 * its reporting terse; the rich, secret-free message from `fixSigning` is
 * carried through on failure for the warning line.
 */
export async function resignAfterUpdate(
  opts: ResignAfterUpdateOptions,
): Promise<ResignAfterUpdateResult> {
  const res = await fixSigning({
    runner: opts.runner,
    vault: opts.vault,
    binPath: opts.binPath,
    home: opts.home,
    timeoutMs: opts.timeoutMs,
  });
  return res.ok
    ? { status: "resigned" }
    : { status: "failed", reason: res.message };
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
}): Promise<
  | { ok: true; keychainCreated: boolean }
  | { ok: false; failedStep: string; keychainCreated: boolean }
> {
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
  if (create.exitCode !== 0)
    return { ok: false, failedStep: "create-keychain", keychainCreated: false };

  // From here on the keychain exists on disk — every exit path must report it
  // as created so the caller's rollback tears down this partial keychain and we
  // never leave a cert-bearing keychain paired with a cleared vault password.
  const keychainCreated = true;

  // No auto-lock / no lock-on-sleep so a long-lived service can always re-sign.
  await run("security", ["set-keychain-settings", keychainPath]);
  const unlock = await run("security", ["unlock-keychain", "-p", password, keychainPath]);
  if (unlock.exitCode !== 0)
    return { ok: false, failedStep: "unlock-keychain", keychainCreated };

  // Generate key + self-signed codesigning cert + p12 in a temp dir we scrub.
  const workdir = await mkdtemp(join(tmpdir(), "phantombot-signing-"));
  const keyPem = join(workdir, "key.pem");
  const certPem = join(workdir, "cert.pem");
  const p12 = join(workdir, "identity.p12");
  try {
    const req = await run(OPENSSL_BIN, [
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
    if (req.exitCode !== 0)
      return { ok: false, failedStep: "openssl-req", keychainCreated };

    const pk = await run(OPENSSL_BIN, [
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
    if (pk.exitCode !== 0)
      return { ok: false, failedStep: "openssl-pkcs12", keychainCreated };

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
    if (imp.exitCode !== 0)
      return { ok: false, failedStep: "import", keychainCreated };

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
    if (part.exitCode !== 0)
      return { ok: false, failedStep: "set-key-partition-list", keychainCreated };

    return { ok: true, keychainCreated };
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

function firstLine(s: string): string {
  return (s.split("\n").find((l) => l.trim().length > 0) ?? "").trim();
}
