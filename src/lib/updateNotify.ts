/**
 * Update lifecycle: pending-update marker + once-per-version notifications.
 *
 * Two concerns, one file:
 *
 *   1. Pending-update marker. The `/update` slash command writes
 *      ~/.config/phantombot/.pending-update.json BEFORE triggering the
 *      restart. On startup, `phantombot run` reads it and notifies Telegram
 *      whether the version that came up matches the target. The marker is
 *      the proof-of-life for "the new binary is up and answering" — without
 *      it the in-process `/update` handler can only say "restarting..."
 *      because by the time the new binary is live the old one is gone.
 *
 *   2. Heartbeat update check. The 30-minute heartbeat hits GitHub for the
 *      latest release; if newer than current and at least 72 hours old,
 *      sends ONE Telegram message pointing the user at `/update`. Deduped via
 *      ~/.config/phantombot/.last-update-notified so a user who's
 *      seen-but-not-yet-installed v1.0.99 isn't pinged every half hour.
 *
 * Both files live next to the existing phantombot config so they survive
 * binary swaps cleanly and don't pollute the user's $HOME.
 *
 * Test surface: every function takes an optional path override and most
 * accept a fetch / transport / runUpdate stub. The compose functions
 * (`runUpdateFlow`, `checkAndNotifyOnce`, `notifyPostRestartIfPending`)
 * are the things tests exercise end-to-end.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  HttpTelegramTransport,
  type TelegramTransport,
} from "../channels/telegram.ts";
import {
  type Config,
  type TelegramAccount,
  resolveDefaultChannel,
  xdgConfigHome,
} from "../config.ts";
import { runNotify } from "../cli/notify.ts";
import { runUpdate } from "../cli/update.ts";
import {
  detectSupportedTarget,
  findLatestRelease,
} from "./githubReleases.ts";
import { log } from "./logger.ts";
import {
  defaultServiceControl,
  type ServiceControl,
} from "./platform.ts";

/* -------------------------------------------------------------------------- *
 * Marker + dedup file paths
 * -------------------------------------------------------------------------- */

export function pendingUpdatePath(): string {
  return join(xdgConfigHome(), "phantombot", ".pending-update.json");
}

export function lastNotifiedPath(): string {
  return join(xdgConfigHome(), "phantombot", ".last-update-notified");
}

export const AUTO_UPDATE_NOTIFY_DELAY_MS = 72 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- *
 * Pending-update marker
 * -------------------------------------------------------------------------- */

export interface PendingUpdate {
  /** Version we expect to be running after the restart, no `v` prefix. */
  targetVersion: string;
  /** Tag string (with `v`), e.g. "v1.0.99". Used to render notifications. */
  targetTag: string;
  /**
   * Telegram chat to notify on success. Set when the update was triggered
   * by an explicit `/update`. May be undefined for future programmatic
   * triggers (e.g. an unattended cron auto-update) — in that case the
   * post-restart notify falls back to broadcasting to allowed_user_ids.
   */
  chatId?: number;
  /**
   * Persona whose Telegram bot handled `/update`. Used after restart to
   * send the confirmation through the same bot in hybrid default+persona
   * configs. Optional so markers written by older versions still work.
   */
  persona?: string;
  /**
   * Version we were on before the update. Stored so we can render
   * "v1.0.42 → v1.0.99" on success and distinguish a real upgrade from
   * a "we were already current" no-op.
   */
  previousVersion: string;
  /** ISO timestamp the marker was written. Used to flag stale markers. */
  writtenAt: string;
}

/** Atomic write so a crash mid-write can't leave a half-parsed marker. */
export async function writePendingUpdate(
  p: PendingUpdate,
  path: string = pendingUpdatePath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(p, null, 2), "utf8");
  await rename(tmp, path);
}

/** Returns undefined if the marker doesn't exist or is unparseable. */
export async function readPendingUpdate(
  path: string = pendingUpdatePath(),
): Promise<PendingUpdate | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    log.warn("updateNotify: failed to read pending-update marker", {
      error: (e as Error).message,
      path,
    });
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as Partial<PendingUpdate>;
    if (
      typeof parsed?.targetVersion !== "string" ||
      typeof parsed?.targetTag !== "string" ||
      typeof parsed?.previousVersion !== "string" ||
      typeof parsed?.writtenAt !== "string" ||
      (parsed.persona !== undefined && typeof parsed.persona !== "string")
    ) {
      log.warn("updateNotify: pending-update marker missing required fields", {
        path,
      });
      return undefined;
    }
    return parsed as PendingUpdate;
  } catch (e) {
    log.warn("updateNotify: pending-update marker is unparseable JSON", {
      error: (e as Error).message,
      path,
    });
    return undefined;
  }
}

export async function clearPendingUpdate(
  path: string = pendingUpdatePath(),
): Promise<void> {
  try {
    await unlink(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("updateNotify: failed to clear pending-update marker", {
        error: (e as Error).message,
        path,
      });
    }
  }
}

/* -------------------------------------------------------------------------- *
 * Last-notified dedup file
 * -------------------------------------------------------------------------- */

interface LastNotifiedState {
  version: string;
  firstSeenAt: string;
  notifiedAt?: string;
}

function parseLastNotifiedState(text: string): LastNotifiedState | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith("{")) {
    // Back-compat for the old plain-version dedup file. Treat it as already
    // notified so existing installs do not get re-pinged after upgrading.
    const legacyTime = new Date(0).toISOString();
    return { version: trimmed, firstSeenAt: legacyTime, notifiedAt: legacyTime };
  }
  try {
    const parsed = JSON.parse(trimmed) as Partial<LastNotifiedState>;
    if (
      typeof parsed.version !== "string" ||
      typeof parsed.firstSeenAt !== "string" ||
      (parsed.notifiedAt !== undefined && typeof parsed.notifiedAt !== "string")
    ) {
      return undefined;
    }
    return parsed as LastNotifiedState;
  } catch {
    return undefined;
  }
}

async function readLastNotifiedState(
  path: string = lastNotifiedPath(),
): Promise<LastNotifiedState | undefined> {
  try {
    return parseLastNotifiedState(await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    log.warn("updateNotify: failed to read last-notified", {
      error: (e as Error).message,
      path,
    });
    return undefined;
  }
}

async function writeLastNotifiedState(
  state: LastNotifiedState,
  path: string = lastNotifiedPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, path);
}

export async function readLastNotified(
  path: string = lastNotifiedPath(),
): Promise<string | undefined> {
  const state = await readLastNotifiedState(path);
  return state?.notifiedAt ? state.version : undefined;
}

export async function writeLastNotified(
  version: string,
  path: string = lastNotifiedPath(),
): Promise<void> {
  const now = new Date().toISOString();
  await writeLastNotifiedState(
    { version, firstSeenAt: now, notifiedAt: now },
    path,
  );
}

/* -------------------------------------------------------------------------- *
 * Compose: /update slash-command flow
 * -------------------------------------------------------------------------- */

export interface RunUpdateFlowInput {
  config: Config;
  currentVersion: string;
  /**
   * Chat that issued the `/update`. Persisted into the marker so the
   * post-restart notify lands in the same DM the request came from.
   */
  chatId: number;
  /** Persona whose Telegram listener handled `/update`. */
  persona?: string;
  fetchImpl?: typeof fetch;
  serviceControl?: ServiceControl;
  /** Test seam — defaults to the real `runUpdate` CLI handler. */
  runUpdateImpl?: typeof runUpdate;
  /** Override marker path (test seam). */
  pendingPath?: string;
  /** Override lastNotified path (test seam). */
  lastNotifiedPath?: string;
  /**
   * Override the per-platform target detection. Tests override this so
   * "fake host" runs of /update don't have to live on supported hardware.
   */
  procPlatform?: string;
  procArch?: string;
}

export interface UpdateFlowResult {
  /** What to tell the user via Telegram before any restart. */
  reply: string;
  /**
   * Set when the flow staged a successful binary swap. The slash handler
   * MUST send `reply` to the user first, THEN call `restart()` — calling
   * it synchronously from inside the handler would race the sendMessage
   * (systemctl restart SIGTERMs us mid-await).
   *
   * The function returns a promise that resolves after `systemctl restart`
   * exits, but the current process is being terminated by that very call,
   * so the resolution is academic.
   */
  restart?: () => Promise<void>;
}

/**
 * The /update command's core. Idempotent — if we're already on latest,
 * it returns a "no-op" reply without touching the filesystem. Otherwise
 * it writes the marker, runs the in-process binary swap, and hands back
 * a `restart()` callback for the channel layer to invoke after the
 * reply has been sent.
 *
 * Why does this take chatId? So the post-restart success message lands in
 * the same DM the request came from, not broadcast to every allowed_user_id.
 */
export async function runUpdateFlow(
  input: RunUpdateFlowInput,
): Promise<UpdateFlowResult> {
  const procPlatform = input.procPlatform ?? process.platform;
  const procArch = input.procArch ?? process.arch;
  const target = detectSupportedTarget(procPlatform, procArch);
  if (!target) {
    return {
      reply:
        `can't self-update on this host: phantombot only ships binaries ` +
        `for linux-x64, linux-arm64, and darwin-arm64 ` +
        `(this machine reports platform=${procPlatform} arch=${procArch})`,
    };
  }

  // 1. Ask GitHub what's latest. Reuse the same client `update --check`
  //    uses so the version comparison agrees byte-for-byte.
  const r = await findLatestRelease({
    target,
    fetchImpl: input.fetchImpl,
  });
  if (!r.ok) {
    return { reply: `couldn't check for updates: ${r.error}` };
  }
  const release = r.release;

  // 2. Idempotent no-op: already current.
  if (release.version === input.currentVersion) {
    return { reply: `already on ${release.tag} — nothing to do` };
  }

  // 3. Write the marker BEFORE touching the binary. If something between
  //    here and `svc.restart()` goes wrong, we want the marker on disk so
  //    a manual restart still surfaces the result to the user. If the
  //    swap then fails (4), we clear the marker — see below.
  await writePendingUpdate(
    {
      targetVersion: release.version,
      targetTag: release.tag,
      chatId: input.chatId,
      persona: input.persona,
      previousVersion: input.currentVersion,
      writtenAt: new Date().toISOString(),
    },
    input.pendingPath,
  );

  // 4. Run the in-process update — downloads, sha256-verifies, swaps the
  //    binary atomically. We pass restart=false because we want to send
  //    the reply BEFORE the restart kills us. The channel layer calls
  //    the returned restart() callback after sendMessage lands.
  const updateImpl = input.runUpdateImpl ?? runUpdate;
  const exitCode = await updateImpl({
    force: true,
    restart: false,
    fetchImpl: input.fetchImpl,
    currentVersion: input.currentVersion,
    serviceControl: input.serviceControl,
    procPlatform: input.procPlatform,
    procArch: input.procArch,
  });
  if (exitCode !== 0) {
    await clearPendingUpdate(input.pendingPath);
    return {
      reply:
        `update to ${release.tag} failed during download/install (exit ${exitCode}). ` +
        `Check phantombot logs.`,
    };
  }

  // 5. Refresh the dedup cache so the heartbeat doesn't immediately
  //    re-notify the user "v1.0.99 available" while we're mid-restart.
  await writeLastNotified(release.version, input.lastNotifiedPath).catch(
    (e: unknown) => {
      log.warn("updateNotify: failed to write last-notified", {
        error: (e as Error).message,
      });
    },
  );

  // 6. Hand the restart trigger back to the caller. They'll send the
  //    reply first, then invoke restart(). Capture the resolved
  //    serviceControl so the restart uses the same backend the rest of
  //    the flow used (matters for tests that inject a stub).
  const svc = input.serviceControl ?? defaultServiceControl();
  const restart = async (): Promise<void> => {
    const r = await svc.restart();
    if (!r.ok) {
      log.error("updateNotify: restart failed after binary swap", {
        stderr: r.stderr,
      });
      // Restart failed — the marker stays so a manual restart will
      // still surface the result. No notify here; the marker fallback
      // handles it.
    }
  };

  return {
    reply:
      `installed ${release.tag} (was ${input.currentVersion}). ` +
      `Restarting now to load the new binary…`,
    restart,
  };
}

/* -------------------------------------------------------------------------- *
 * Compose: heartbeat check + once-per-version notify
 * -------------------------------------------------------------------------- */

export interface CheckAndNotifyOnceInput {
  config: Config;
  currentVersion: string;
  now?: Date;
  fetchImpl?: typeof fetch;
  transport?: TelegramTransport;
  lastNotifiedPath?: string;
  procPlatform?: string;
  procArch?: string;
}

export interface CheckAndNotifyOnceResult {
  /** "no_telegram" | "no_target" | "release_check_failed" | "already_current"
   *  | "waiting_delay" | "already_notified" | "no_allowed_users" | "notified" */
  status:
    | "no_telegram"
    | "no_target"
    | "release_check_failed"
    | "already_current"
    | "waiting_delay"
    | "already_notified"
    | "no_allowed_users"
    | "notified";
  latestVersion?: string;
  notifiedRecipients?: number;
  error?: string;
}

/**
 * Heartbeat-time update check. Idempotent: if the latest GitHub release
 * matches what we last notified about, this is a no-op — even across
 * restarts, because the last-notified version is on disk. New releases are
 * held for 72 hours before the automatic Telegram heads-up; manual
 * `phantombot update` and `/update` remain immediate.
 *
 * Failure modes are all logged and returned as a status string; we don't
 * throw, because a transient network blip mustn't take the heartbeat down.
 */
export async function checkAndNotifyOnce(
  input: CheckAndNotifyOnceInput,
): Promise<CheckAndNotifyOnceResult> {
  // The "update available" heads-up is UNSOLICITED, so it follows
  // default_channel. For a Matrix default we route the final send through
  // runNotify (which owns Matrix account + DM resolution); the dedup/delay
  // bookkeeping below is channel-agnostic and runs identically. Telegram keeps
  // its bespoke transport path verbatim (the common case, with its own tests).
  const channel = resolveDefaultChannel(input.config);
  if (channel === "matrix") {
    return checkAndNotifyOnceMatrix(input);
  }

  const tg = input.config.channels.telegram;
  if (!tg) return { status: "no_telegram" };

  const procPlatform = input.procPlatform ?? process.platform;
  const procArch = input.procArch ?? process.arch;
  const target = detectSupportedTarget(procPlatform, procArch);
  if (!target) return { status: "no_target" };

  const r = await findLatestRelease({
    target,
    fetchImpl: input.fetchImpl,
  });
  if (!r.ok) {
    log.warn("updateNotify: heartbeat release-check failed", {
      error: r.error,
    });
    return { status: "release_check_failed", error: r.error };
  }
  const release = r.release;
  const now = input.now ?? new Date();

  if (release.version === input.currentVersion) {
    return { status: "already_current", latestVersion: release.version };
  }

  const state = await readLastNotifiedState(input.lastNotifiedPath);
  if (state?.version === release.version && state.notifiedAt) {
    return { status: "already_notified", latestVersion: release.version };
  }

  const firstSeenAt =
    (state?.version === release.version ? state.firstSeenAt : undefined) ??
    release.publishedAt ??
    now.toISOString();
  const releaseAgeMs = now.getTime() - Date.parse(firstSeenAt);
  if (
    !Number.isFinite(releaseAgeMs) ||
    releaseAgeMs < AUTO_UPDATE_NOTIFY_DELAY_MS
  ) {
    await writeLastNotifiedState(
      { version: release.version, firstSeenAt },
      input.lastNotifiedPath,
    );
    return { status: "waiting_delay", latestVersion: release.version };
  }

  if (tg.allowedUserIds.length === 0) {
    log.warn(
      "updateNotify: telegram has no allowed_user_ids; refusing to broadcast",
    );
    return { status: "no_allowed_users", latestVersion: release.version };
  }

  const transport = input.transport ?? new HttpTelegramTransport(tg.token);
  const message =
    `📦 phantombot ${release.tag} is available ` +
    `(you're on ${input.currentVersion}).\n\n` +
    `Send /update to install it.`;

  let sent = 0;
  for (const chatId of tg.allowedUserIds) {
    try {
      // transport.sendMessage takes the channel-neutral string id; these
      // recipients come from the numeric config allowlist.
      await transport.sendMessage(String(chatId), message);
      sent++;
    } catch (e) {
      log.warn("updateNotify: heartbeat notify send failed", {
        chatId,
        error: (e as Error).message,
      });
    }
  }

  // Write the dedup marker even if some sends failed — otherwise a
  // partial-broadcast user gets re-notified forever. Better one missed
  // user than one re-pinged user.
  await writeLastNotifiedState(
    { version: release.version, firstSeenAt, notifiedAt: now.toISOString() },
    input.lastNotifiedPath,
  );

  log.info("updateNotify: heartbeat notified update available", {
    latestVersion: release.version,
    recipients: sent,
  });

  return {
    status: "notified",
    latestVersion: release.version,
    notifiedRecipients: sent,
  };
}

/**
 * Matrix variant of the heartbeat update-available check. Same release-check +
 * 72h delay + dedup bookkeeping as the Telegram path, but the final send goes
 * through `runNotify({ channel: "matrix" })`. Kept as a sibling rather than
 * inlined so the Telegram path (and its tests) are completely untouched.
 */
async function checkAndNotifyOnceMatrix(
  input: CheckAndNotifyOnceInput,
): Promise<CheckAndNotifyOnceResult> {
  const mx = input.config.channels.matrix;
  // Reuse "no_telegram" as the generic "no default-channel account" status so
  // the result union doesn't need a new member; the heartbeat only logs it.
  if (!mx) return { status: "no_telegram" };

  const procPlatform = input.procPlatform ?? process.platform;
  const procArch = input.procArch ?? process.arch;
  const target = detectSupportedTarget(procPlatform, procArch);
  if (!target) return { status: "no_target" };

  const r = await findLatestRelease({ target, fetchImpl: input.fetchImpl });
  if (!r.ok) {
    log.warn("updateNotify: heartbeat release-check failed", { error: r.error });
    return { status: "release_check_failed", error: r.error };
  }
  const release = r.release;
  const now = input.now ?? new Date();

  if (release.version === input.currentVersion) {
    return { status: "already_current", latestVersion: release.version };
  }

  const state = await readLastNotifiedState(input.lastNotifiedPath);
  if (state?.version === release.version && state.notifiedAt) {
    return { status: "already_notified", latestVersion: release.version };
  }

  const firstSeenAt =
    (state?.version === release.version ? state.firstSeenAt : undefined) ??
    release.publishedAt ??
    now.toISOString();
  const releaseAgeMs = now.getTime() - Date.parse(firstSeenAt);
  if (!Number.isFinite(releaseAgeMs) || releaseAgeMs < AUTO_UPDATE_NOTIFY_DELAY_MS) {
    await writeLastNotifiedState(
      { version: release.version, firstSeenAt },
      input.lastNotifiedPath,
    );
    return { status: "waiting_delay", latestVersion: release.version };
  }

  if (mx.allowedUserIds.length === 0) {
    log.warn("updateNotify: matrix has no allowed_user_ids; refusing to broadcast");
    return { status: "no_allowed_users", latestVersion: release.version };
  }

  const message =
    `📦 phantombot ${release.tag} is available ` +
    `(you're on ${input.currentVersion}).\n\n` +
    `Send /update to install it.`;
  const code = await runNotify({
    config: input.config,
    message,
    channel: "matrix",
  });

  await writeLastNotifiedState(
    { version: release.version, firstSeenAt, notifiedAt: now.toISOString() },
    input.lastNotifiedPath,
  );

  log.info("updateNotify: heartbeat notified update available (matrix)", {
    latestVersion: release.version,
    notifyExit: code,
  });

  return {
    status: "notified",
    latestVersion: release.version,
    notifiedRecipients: mx.allowedUserIds.length,
  };
}

/* -------------------------------------------------------------------------- *
 * Compose: post-restart confirmation on startup
 * -------------------------------------------------------------------------- */

export interface NotifyPostRestartInput {
  config: Config;
  currentVersion: string;
  transport?: TelegramTransport;
  createTransport?: (account: TelegramAccount) => TelegramTransport;
  pendingPath?: string;
  /**
   * Account to use for the post-restart notify when there's no default
   * `[channels.telegram]` block (personas-only setup). Caller passes the
   * admin listener's account here. When omitted, falls back to
   * `config.channels.telegram` (legacy behavior).
   */
  adminAccount?: TelegramAccount;
}

export interface NotifyPostRestartResult {
  /** "no_marker" | "success_notified" | "failure_notified" | "no_telegram" */
  status:
    | "no_marker"
    | "success_notified"
    | "failure_notified"
    | "no_telegram";
  marker?: PendingUpdate;
}

/**
 * Read the pending-update marker (if any), notify Telegram with the
 * appropriate success/failure message, and delete the marker.
 *
 * Cases:
 *   - no marker            → no-op, status "no_marker"
 *   - marker matches       → "✅ Updated to vX.Y.Z" then delete marker
 *   - marker doesn't match → "⚠️ Update to vX.Y.Z failed, still on vA.B.C"
 *                            then delete marker (don't keep retrying — if
 *                            the user wants to try again they /update)
 *
 * Recipient: marker.chatId if set, otherwise broadcasts to all
 * allowedUserIds (same fan-out as `phantombot notify`).
 */
export async function notifyPostRestartIfPending(
  input: NotifyPostRestartInput,
): Promise<NotifyPostRestartResult> {
  const marker = await readPendingUpdate(input.pendingPath);
  if (!marker) return { status: "no_marker" };

  // Pick the account that drives this notify. New markers include the
  // persona that handled `/update`, so hybrid default+persona configs can
  // reply through that same bot. Older markers have no persona and fall
  // back to the admin/default behavior.
  const adminAccount =
    (marker.persona
      ? input.config.channels.telegramPersonas?.[marker.persona]
      : undefined) ??
    input.adminAccount ??
    input.config.channels.telegram;
  if (!adminAccount) {
    // Marker exists but Telegram isn't configured — just clear it. No
    // way to notify; the user will see the version change on their next
    // CLI call.
    log.info(
      "updateNotify: pending-update marker present but telegram not configured; clearing without notify",
      { targetTag: marker.targetTag },
    );
    await clearPendingUpdate(input.pendingPath);
    return { status: "no_telegram", marker };
  }

  const transport =
    input.transport ??
    input.createTransport?.(adminAccount) ??
    new HttpTelegramTransport(adminAccount.token);

  const success = marker.targetVersion === input.currentVersion;
  const message = success
    ? `✅ Updated to ${marker.targetTag} (was v${marker.previousVersion}). Back online.`
    : `⚠️ Update to ${marker.targetTag} didn't take — still on v${input.currentVersion}. ` +
      `Check phantombot logs and try /update again.`;

  // Recipient rule: explicit chatId from the marker wins; fall back to
  // broadcasting to allowed_user_ids when the marker came from a non-
  // chat path (e.g. heartbeat-triggered, future feature).
  const recipients =
    typeof marker.chatId === "number"
      ? [marker.chatId]
      : adminAccount.allowedUserIds;

  for (const chatId of recipients) {
    try {
      // String id at the transport boundary; recipients are numeric Telegram
      // chat ids (marker or config allowlist).
      await transport.sendMessage(String(chatId), message);
    } catch (e) {
      log.warn("updateNotify: post-restart notify send failed", {
        chatId,
        error: (e as Error).message,
      });
    }
  }

  await clearPendingUpdate(input.pendingPath);

  return {
    status: success ? "success_notified" : "failure_notified",
    marker,
  };
}
