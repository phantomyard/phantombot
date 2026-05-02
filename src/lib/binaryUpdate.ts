/**
 * Download + SHA256-verify + atomically swap a phantombot binary.
 *
 * The actual filesystem swap relies on Linux semantics: rename(2) over
 * the currently-executing binary is safe. The kernel keeps the running
 * process backed by the original inode; the new file gets a fresh inode
 * at the same path. The next exec() of that path picks up the new file.
 *
 * SHA256 verification is mandatory — we refuse to swap if the downloaded
 * bytes don't match SHA256SUMS. A poisoned mirror or in-flight tamper
 * stops the install instead of running a hostile binary on the host.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";

export interface DownloadAndVerifyOpts {
  /** URL of the binary asset (browser_download_url from the release). */
  binaryUrl: string;
  /** URL of the SHA256SUMS file (browser_download_url from the release). */
  checksumsUrl: string;
  /** The asset name as it appears in SHA256SUMS, e.g. phantombot-v1.0.43-linux-x64. */
  expectedAssetName: string;
  /** Where to write the verified binary. Caller picks; usually `${execPath}.update.tmp`. */
  destPath: string;
  fetchImpl?: typeof fetch;
}

export type DownloadResult =
  | { ok: true; bytes: number; sha256: string }
  | { ok: false; error: string };

/**
 * Stream the asset to destPath, then re-read it to compute SHA256, then
 * compare against the SHA256SUMS entry for expectedAssetName. On any
 * failure (network, missing entry, mismatch) the partial file is removed.
 */
export async function downloadAndVerify(
  opts: DownloadAndVerifyOpts,
): Promise<DownloadResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;

  // 1. Fetch the SHA256SUMS file first. If the upstream is broken or
  // tampered with, we want to fail before downloading 100MB of binary.
  let checksumsRes: Response;
  try {
    checksumsRes = await fetchImpl(opts.checksumsUrl);
  } catch (e) {
    return {
      ok: false,
      error: `network error fetching SHA256SUMS: ${(e as Error).message}`,
    };
  }
  if (!checksumsRes.ok) {
    return {
      ok: false,
      error: `SHA256SUMS download HTTP ${checksumsRes.status}`,
    };
  }
  const checksumsText = await checksumsRes.text();
  const expectedSha256 = parseSha256SumsLine(
    checksumsText,
    opts.expectedAssetName,
  );
  if (!expectedSha256) {
    return {
      ok: false,
      error: `SHA256SUMS has no entry for ${opts.expectedAssetName}`,
    };
  }

  // 2. Download the binary.
  let binRes: Response;
  try {
    binRes = await fetchImpl(opts.binaryUrl);
  } catch (e) {
    return {
      ok: false,
      error: `network error fetching binary: ${(e as Error).message}`,
    };
  }
  if (!binRes.ok) {
    return { ok: false, error: `binary download HTTP ${binRes.status}` };
  }
  const bytes = Buffer.from(await binRes.arrayBuffer());

  // 3. Verify SHA256.
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== expectedSha256) {
    return {
      ok: false,
      error: `SHA256 mismatch for ${opts.expectedAssetName}: expected ${expectedSha256}, got ${actualSha256}`,
    };
  }

  // 4. Write to destPath at mode 0o755 (executable).
  try {
    await writeFile(opts.destPath, bytes, { mode: 0o755 });
    // writeFile mode is honored only on file CREATION; existing files
    // keep their old mode. Force-set explicitly so re-runs with a stale
    // tmp don't end up unexecutable.
    await chmod(opts.destPath, 0o755);
  } catch (e) {
    // Defensive cleanup so a partial write doesn't haunt later runs.
    await rm(opts.destPath, { force: true });
    return {
      ok: false,
      error: `failed writing ${opts.destPath}: ${(e as Error).message}`,
    };
  }

  return { ok: true, bytes: bytes.byteLength, sha256: actualSha256 };
}

/**
 * Pure parser exposed for testing. SHA256SUMS files are one entry per
 * line, formatted by `sha256sum`: `<hex>  <filename>` (two spaces, no
 * newlines inside an entry). Returns the hex digest if found, undefined
 * otherwise.
 */
export function parseSha256SumsLine(
  text: string,
  filename: string,
): string | undefined {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // Accept either two-space (text-mode) or one-space-and-asterisk (binary-mode).
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(line);
    if (!m || !m[1] || !m[2]) continue;
    if (m[2] === filename) return m[1].toLowerCase();
  }
  return undefined;
}

export interface ApplyUpdateOpts {
  /** Path of the freshly-downloaded, verified binary (e.g. `${target}.update.tmp`). */
  tempPath: string;
  /** Path of the binary to replace (usually process.execPath). */
  targetPath: string;
}

export type ApplyResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Atomic swap. Steps:
 *   1. Remove any stale ${targetPath}.bak (defensive — see below).
 *   2. Copy targetPath → ${targetPath}.bak (transactional safety net
 *      in case the rename in step 3 fails).
 *   3. rename(tempPath, targetPath) — atomic on Linux even when
 *      targetPath is the running process's binary; the kernel uses
 *      inode, not path.
 *   4. On success, remove ${targetPath}.bak. The .bak only existed
 *      to make the rename recoverable; once the rename committed,
 *      it's garbage. Cleaning it keeps ~/.local/bin/ tidy (no .bak
 *      polluting tab-completion next to the live binary).
 *
 * Why we explicitly unlink the .bak before copying in step 1:
 * copyFile opens the destination with O_TRUNC. Linux requires write
 * permission on an existing file to truncate it, even if the parent
 * dir is writable. So if a previous .bak was written by a different
 * user (e.g. an earlier `sudo cp` during initial deploy left a
 * root-owned .bak — see PR #47's repro), running `phantombot update`
 * as the unprivileged service user would fail with EACCES — even
 * though that user owns the dir and the live binary. unlink only
 * needs write+execute on the parent dir, which we've already
 * verified via checkWritable, so an old foreign-owned .bak can be
 * cleared without elevated privileges.
 *
 * Returns just `{ ok: true }` on success — no backupPath, because
 * the .bak no longer exists. Callers that previously surfaced the
 * .bak path to the user should drop that line.
 */
export async function applyUpdate(opts: ApplyUpdateOpts): Promise<ApplyResult> {
  if (!existsSync(opts.tempPath)) {
    return { ok: false, error: `temp file missing: ${opts.tempPath}` };
  }
  const backupPath = `${opts.targetPath}.bak`;
  try {
    if (existsSync(opts.targetPath)) {
      // Defensive unlink of any stale backup from a prior install (see
      // doc above). Best-effort: rm errors are swallowed because the
      // copyFile that follows surfaces the real one if the dir itself
      // isn't writable.
      await rm(backupPath, { force: true });
      // copyFile (not rename) so we keep targetPath intact in case the
      // rename in step 2 fails — we always have a working binary on disk.
      await copyFile(opts.targetPath, backupPath);
    }
  } catch (e) {
    return {
      ok: false,
      error: `failed to back up ${opts.targetPath}: ${(e as Error).message}`,
    };
  }
  try {
    await rename(opts.tempPath, opts.targetPath);
  } catch (e) {
    // Best-effort rollback: if backup exists, restore it.
    if (existsSync(backupPath)) {
      try {
        await copyFile(backupPath, opts.targetPath);
      } catch {
        /* if restore fails too, the user has the .bak to copy by hand */
      }
    }
    return {
      ok: false,
      error: `failed to swap ${opts.tempPath} → ${opts.targetPath}: ${(e as Error).message}`,
    };
  }
  // Step 4: rename committed; the .bak is no longer needed. Remove
  // it so it doesn't pollute the install dir's tab-completion. If
  // the unlink fails (rare — would need a filesystem error), the
  // .bak just sits there until the next update cleans it via step 1.
  try {
    await rm(backupPath, { force: true });
  } catch {
    /* best-effort cleanup; the next update will retry */
  }
  return { ok: true };
}

/**
 * Quick capability check before we bother downloading anything: can we
 * actually write to (and replace) the binary at targetPath? Returns
 * undefined when writeable, or a hint string the CLI can surface.
 *
 * Linux's rule: replacing a file by name needs write+execute on the
 * containing directory, NOT write on the file itself. So we test the
 * dirname's writability via stat + euid match (close enough — true
 * permission check requires access(2) which Bun exposes via fs/promises).
 */
export async function checkWritable(
  targetPath: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Use fs.access with W_OK on the parent dir; that's the actual
  // permission Linux enforces for rename-over-existing.
  const { access, constants } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const parent = dirname(targetPath);
  try {
    await access(parent, constants.W_OK);
  } catch {
    return {
      ok: false,
      reason: `no write access to ${parent}; re-run with sudo or relocate the binary to a user-writable path`,
    };
  }
  // Sanity: does targetPath actually exist?
  try {
    await stat(targetPath);
  } catch {
    return {
      ok: false,
      reason: `target ${targetPath} doesn't exist; nothing to update (are you running phantombot from source via bun?)`,
    };
  }
  return { ok: true };
}
