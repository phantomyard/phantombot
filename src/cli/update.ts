/**
 * `phantombot update` — fetch latest GitHub Release, verify, atomically
 * swap the running binary, optionally restart the service.
 *
 * Flag matrix:
 *   (none)           interactive TUI; confirm before installing; prompt for restart
 *   --check          print "X newer than Y" or "up to date"; exit 0/2/1
 *   --force          skip the install confirm (cron-friendly)
 *   --restart        skip the restart prompt and just restart
 *   --force --restart  fully unattended; ideal for cron
 *
 * Exit codes (chosen to be cron-alertable):
 *   0   — updated successfully, OR already on the latest version
 *   1   — error (network, checksum mismatch, write-permission, etc.)
 *   2   — update available but not installed (only with --check)
 */

import { defineCommand } from "citty";
import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import * as p from "@clack/prompts";

import {
  applyUpdate,
  checkWritable,
  downloadAndVerify,
} from "../lib/binaryUpdate.ts";
import {
  detectSupportedArch,
  findLatestRelease,
  type LatestRelease,
} from "../lib/githubReleases.ts";
import {
  defaultServiceControl,
  type ServiceControl,
} from "../lib/systemd.ts";
import type { WriteSink } from "../lib/io.ts";
import { VERSION } from "../version.ts";

export interface RunUpdateInput {
  check?: boolean;
  force?: boolean;
  restart?: boolean;
  /** Defaults to process.execPath. Tests override. */
  binPath?: string;
  /**
   * Raw arch string (matches `process.arch`); converted via
   * detectSupportedArch internally. Defaults to process.arch. Tests pass
   * a value like "ia32" to exercise the unsupported-arch refusal.
   */
  procArch?: string;
  /** Defaults to VERSION constant. Tests override. */
  currentVersion?: string;
  /** Inject for testing. */
  fetchImpl?: typeof fetch;
  serviceControl?: ServiceControl;
  /** Inject confirm to bypass @clack's TTY-only prompt in tests. */
  confirmInstall?: (release: LatestRelease) => Promise<boolean>;
  confirmRestart?: () => Promise<boolean>;
  out?: WriteSink;
  err?: WriteSink;
}

export async function runUpdate(input: RunUpdateInput = {}): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const currentVersion = input.currentVersion ?? VERSION;
  const procArch = input.procArch ?? process.arch;
  const arch = detectSupportedArch(procArch);

  if (!arch) {
    err.write(
      `phantombot is only released for linux-x64 and linux-arm64; this machine reports arch=${procArch}\n`,
    );
    return 1;
  }

  // Resolve symlinks so target swaps land on the real file. Without this,
  // a `~/.local/bin/phantombot → /opt/phantombot/bin/phantombot` symlink
  // would have its symlink replaced by a regular binary.
  const rawBinPath = input.binPath ?? process.execPath;
  let binPath: string;
  try {
    binPath = await realpath(rawBinPath);
  } catch {
    binPath = rawBinPath;
  }

  if (basename(binPath) !== "phantombot") {
    err.write(
      `not a phantombot binary at ${binPath} (basename=${basename(binPath)}). ` +
        `Are you running from source via 'bun src/index.ts'? ` +
        `Build a release binary with 'bun run build' first.\n`,
    );
    return 1;
  }

  // 1. Discover latest release.
  const r = await findLatestRelease({
    arch,
    fetchImpl: input.fetchImpl,
  });
  if (!r.ok) {
    err.write(`update check failed: ${r.error}\n`);
    return 1;
  }
  const release = r.release;

  // 2. Compare versions.
  if (release.version === currentVersion) {
    out.write(`Already on ${release.tag}.\n`);
    return 0;
  }

  // 3. --check just reports.
  if (input.check) {
    out.write(`Update available: ${currentVersion} → ${release.version}\n`);
    out.write(`  asset:  ${release.binary.name} (${formatBytes(release.binary.size)})\n`);
    return 2;
  }

  // 4. Confirm install (skip with --force).
  if (!input.force) {
    const confirm =
      input.confirmInstall ??
      (async (rel) => defaultConfirmInstall(rel, currentVersion));
    const proceed = await confirm(release);
    if (!proceed) {
      out.write("update cancelled.\n");
      return 0;
    }
  }

  // 5. Permission precheck — fail fast before downloading 100MB.
  const writable = await checkWritable(binPath);
  if (!writable.ok) {
    err.write(`cannot install update: ${writable.reason}\n`);
    return 1;
  }

  // 6. Download + SHA256 verify.
  const tempPath = `${binPath}.update.tmp`;
  out.write(`downloading ${release.binary.name}…\n`);
  const dl = await downloadAndVerify({
    binaryUrl: release.binary.url,
    checksumsUrl: release.checksums.url,
    expectedAssetName: release.binary.name,
    destPath: tempPath,
    fetchImpl: input.fetchImpl,
  });
  if (!dl.ok) {
    err.write(`download failed: ${dl.error}\n`);
    return 1;
  }
  out.write(`verified ${formatBytes(dl.bytes)} (sha256 ok).\n`);

  // 7. Atomic swap.
  const swap = await applyUpdate({ tempPath, targetPath: binPath });
  if (!swap.ok) {
    err.write(`install failed: ${swap.error}\n`);
    return 1;
  }
  out.write(
    `installed ${release.tag} at ${binPath} (previous binary saved to ${swap.backupPath}).\n`,
  );

  // 8. Restart handling. The running phantombot process keeps its
  // in-memory binary, so restart is needed to actually load the new bits.
  const svc = input.serviceControl ?? defaultServiceControl();
  let shouldRestart = input.restart ?? false;
  if (!input.restart && !input.force) {
    const confirmRestart =
      input.confirmRestart ?? defaultConfirmRestart;
    if (await svc.isActive()) {
      shouldRestart = await confirmRestart();
    }
  }
  if (shouldRestart) {
    const r = await svc.restart();
    if (r.ok) {
      out.write("restarted phantombot.service.\n");
    } else {
      err.write(
        `restart failed: ${r.stderr ?? "unknown"} — run 'systemctl --user restart phantombot' manually.\n`,
      );
      // Don't fail the whole command; the binary swap succeeded. The
      // user just needs to restart by hand.
    }
  } else if (!input.force) {
    out.write(
      "restart with: systemctl --user restart phantombot\n",
    );
  }

  return 0;
}

async function defaultConfirmInstall(
  release: LatestRelease,
  currentVersion: string,
): Promise<boolean> {
  p.intro(`phantombot update`);
  const summary =
    `current:   ${currentVersion}\n` +
    `available: ${release.version} (${release.tag})\n` +
    `asset:     ${release.binary.name} (${formatBytes(release.binary.size)})\n` +
    (release.body
      ? `\n--- release notes ---\n${truncate(release.body, 800)}`
      : "");
  p.note(summary, "Update available");
  const r = await p.confirm({
    message: `Install ${release.tag}?`,
    initialValue: true,
  });
  return !p.isCancel(r) && r === true;
}

async function defaultConfirmRestart(): Promise<boolean> {
  const r = await p.confirm({
    message: "phantombot is currently running. Restart now to load the new binary?",
    initialValue: true,
  });
  return !p.isCancel(r) && r === true;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n…[release notes truncated]";
}

export default defineCommand({
  meta: {
    name: "update",
    description:
      "Fetch the latest phantombot release, verify the SHA256, atomically swap the running binary, and optionally restart the service.",
  },
  args: {
    check: {
      type: "boolean",
      description: "Print whether an update is available without installing. Exit code 2 if available, 0 if up to date.",
      default: false,
    },
    force: {
      type: "boolean",
      description: "Skip the install confirmation (use from cron).",
      default: false,
    },
    restart: {
      type: "boolean",
      description: "Restart phantombot.service after installing. Useful with --force for unattended updates.",
      default: false,
    },
  },
  async run({ args }) {
    process.exitCode = await runUpdate({
      check: args.check as boolean,
      force: args.force as boolean,
      restart: args.restart as boolean,
    });
  },
});
