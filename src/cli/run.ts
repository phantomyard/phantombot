/**
 * `phantombot run` — long-running channel listener (Telegram for v1).
 * Stays in the foreground. Ctrl-C to stop. Daemonize via systemd
 * (`phantombot install`) or `nohup phantombot run &`.
 *
 * Replaces the older `phantombot serve --telegram`.
 */

import { defineCommand } from "citty";
import { existsSync } from "node:fs";

import { hostname } from "node:os";

import {
  HttpTelegramTransport,
  runTelegramServer,
} from "../channels/telegram.ts";
import { TELEGRAM_BOT_COMMANDS } from "../channels/commands.ts";
import { createPhantomchatChannel } from "../channels/phantomchat/channel.ts";
import { runPhantomchatServer } from "../channels/phantomchat/server.ts";
import { SimplePoolPhantomchatTransport } from "../channels/phantomchat/transport.ts";
import {
  listPhantomchatPersonas,
  cacheRelaysForPersona,
  recordTrustedNpub,
  recordGreeted,
} from "../channels/phantomchat/personaStore.ts";
import {
  resolvePersonaGreeting,
  greetPendingNpubs,
} from "../channels/phantomchat/greet.ts";
import {
  fetchCanonicalRelays,
  sameRelays,
} from "../channels/phantomchat/relaysSource.ts";
import { cleanupStaleUpdateArtifacts } from "../lib/binaryUpdate.ts";
import { npubEncode } from "../lib/nostrIdentity.ts";
import {
  type Config,
  DEFAULT_P2P,
  loadConfig,
  personaDir,
  type TelegramAccount,
  withHostHarnessBins,
} from "../config.ts";
import { readConfigToml } from "../lib/configWriter.ts";
import {
  migratePersonaConfig,
  personaConfigPath,
} from "../lib/personaConfig.ts";
import {
  advertiseP2PCapability,
  buildP2PNode,
  ChannelBridge,
  startP2PNode,
} from "../p2p/index.ts";
import { buildHarnessChain } from "../harnesses/buildChain.ts";
import {
  resolveHarnessBinsForConfig,
  type HarnessAvailability,
} from "../lib/harnessAvailability.ts";
import type { WriteSink } from "../lib/io.ts";
import { log } from "../lib/logger.ts";
import { harnessAlerter } from "../lib/harnessAlert.ts";
import { runNotify } from "./notify.ts";
import { healDefaultPersonaIfBroken } from "../lib/personaDefault.ts";
import { isPhantombotBinary } from "../lib/binaryIdentity.ts";
import { currentPlatform, logsCommand, statusCommand } from "../lib/platform.ts";
import {
  BunSchtasksRunner,
  currentPersonaName,
  migrateBootSchemaIfNeeded,
} from "../lib/taskScheduler.ts";
import { defaultReadVaultWindowsPassword } from "./install.ts";
import {
  acquireRunLock,
  defaultLockPath,
  isLockHandle,
} from "../lib/runLock.ts";
import {
  notifyPhantomchatPostRestart,
  notifyPostRestartIfPending,
} from "../lib/updateNotify.ts";
import { openMemoryStore } from "../memory/store.ts";
import { VERSION } from "../version.ts";
import { runDoctor } from "./doctor.ts";
import { spawnNightlySweep } from "../lib/nightlyTrigger.ts";
import { ensureRoutingExtension } from "../lib/piExtensionProvision.ts";
import { reconcileEditorConnectors } from "../connectors/acp/autoInstall.ts";

/**
 * After SIGINT/SIGTERM we abort and let the event loop drain naturally. If a
 * lingering handle (e.g. a relay ws.close() stuck on a half-open socket) keeps
 * the loop alive past this window, force a clean exit rather than ride to
 * systemd's 90s SIGKILL. .unref()'d, so clean shutdowns never wait on it.
 */
export const SHUTDOWN_GRACE_MS = 5000;

/**
 * Arm a one-shot watchdog that runs `onForce` if graceful teardown hasn't
 * drained the event loop within `graceMs`. .unref()'d so a clean shutdown
 * (the common case) exits on its own without ever waiting on this timer —
 * it only bites when a lingering handle would otherwise wedge the process.
 */
export function armShutdownWatchdog(
  graceMs: number,
  onForce: () => void,
): ReturnType<typeof setTimeout> {
  const t = setTimeout(onForce, graceMs);
  t.unref();
  return t;
}

export interface RunInput {
  config?: Config;
  out?: WriteSink;
  err?: WriteSink;
  /** Override the lock file path (for testing). */
  lockPath?: string;
  /** Treat an existing run lock as a healthy no-op (used by supervisors). */
  ifNotRunning?: boolean;
  /** Test seam for harness binary availability. Pass false to skip. */
  checkHarnesses?:
    | false
    | ((config: Config) => Promise<HarnessAvailability[]>);
  runTelegramServer?: typeof runTelegramServer;
  /**
   * Test seam for the phantomchat server. Production uses the real
   * `runPhantomchatServer` over a SimplePool relay transport; tests inject a
   * stub so run-wiring can be asserted without touching real relays.
   */
  runPhantomchatServer?: typeof runPhantomchatServer;
  /**
   * Test seam for per-persona config resolution (phantombot#439). Production
   * calls `loadConfig(persona)`, which layers `<persona>/config.toml` over the
   * host globals.
   */
  loadPersonaConfig?: (persona: string) => Promise<Config>;
}

/** One persona-bound listener that runRun() will spawn. */
export interface ListenerSpec {
  persona: string;
  agentDir: string;
  account: TelegramAccount;
  /** "default", "autostart.<name>" or "personas.<name>" — for log/error text. */
  source: string;
  /**
   * The persona's EFFECTIVE config: the host globals with that persona's own
   * `<persona>/config.toml` layered on top (phantombot#439). Optional so
   * existing callers and fixtures keep working; when absent the caller falls
   * back to the process-wide config, which is exactly the pre-#439 behaviour.
   */
  config?: Config;
}

/**
 * Which PhantomChat personas this host is allowed to START (phantombot#439).
 *
 * `listPhantomchatPersonas` SCANS THE DISK: every persona directory holding a
 * `phantomchat.json` comes back. That is the right answer for "who is
 * configured" and the wrong answer for "who should talk to the world" — an
 * imported, restored or archived-and-recreated identity would start answering
 * strangers purely because its directory exists. The explicit boot roster is
 * `default_persona` + `autostart_personas`, exactly as for Telegram.
 *
 * The gate is opt-in, and deliberately so: `autostart_personas` ABSENT means
 * this host has never been told what to start, so every configured identity
 * keeps starting exactly as it did before this landed — no silent channel loss
 * on upgrade. Once the key is present (even as an empty list) it is the whole
 * truth, and anything outside it is skipped with a warning naming the fix.
 */
export function selectPhantomchatPersonas<T extends { persona: string }>(
  specs: T[],
  config: Pick<Config, "autostartPersonas">,
  defaultPersona: string,
  err: WriteSink,
): T[] {
  const autostart = config.autostartPersonas;
  if (autostart === undefined) return specs;
  const roster = new Set([defaultPersona, ...autostart]);
  const out: T[] = [];
  for (const spec of specs) {
    if (roster.has(spec.persona)) {
      out.push(spec);
      continue;
    }
    err.write(
      `warning: phantomchat persona '${spec.persona}' is configured but not in ` +
        `autostart_personas — not starting it. Add it to autostart_personas in ` +
        `config.toml (or run \`phantombot persona\`) to start it.\n`,
    );
  }
  return out;
}

/**
 * Build the list of listeners to spawn from the resolved config.
 * - `[channels.telegram]` becomes one listener bound to `defaultPersona`.
 * - Each `[channels.telegram.personas.<name>]` becomes a listener bound
 *   to that persona.
 *
 * Missing persona dirs are dropped with a warn so a typo in one persona
 * block doesn't take down the others. Duplicate tokens (the same bot
 * reused by two personas) fail fast — Telegram serializes long-poll on
 * a single token so two listeners on the same bot would silently
 * starve each other.
 */
export function planListeners(
  config: Config,
  defaultPersona: string,
  err: WriteSink,
  personaConfigs?: Map<string, Config>,
): { listeners: ListenerSpec[]; fatal?: string } {
  const listeners: ListenerSpec[] = [];
  const warnedIncomplete = new Set<string>();
  const warnIncomplete = (persona: string, source: string): void => {
    if (warnedIncomplete.has(persona)) return;
    warnedIncomplete.add(persona);
    err.write(
      `warning: persona '${persona}' states ${source} but no bot_token — ` +
        "no telegram listener will start\n",
    );
  };

  if (config.channels.telegram) {
    const agentDir = personaDir(config, defaultPersona);
    if (existsSync(agentDir)) {
      listeners.push({
        persona: defaultPersona,
        agentDir,
        account: config.channels.telegram,
        source: "default",
        config,
      });
    } else {
      err.write(
        `warning: default persona '${defaultPersona}' agent dir missing at ${agentDir} — skipping default telegram listener\n`,
      );
    }
  } else if (config.channels.telegramStated) {
    warnIncomplete(defaultPersona, "[channels.telegram]");
  }

  // Autostart personas (phantombot#439): each brings its OWN
  // `<persona>/config.toml`, so its bot is `[channels.telegram]` in that file
  // rather than an entry in the host's `[channels.telegram.personas]` table.
  // The default persona is skipped — it is already started above, and starting
  // it twice would trip the duplicate-token guard on its own bot.
  for (const persona of config.autostartPersonas ?? []) {
    if (persona === defaultPersona) continue;
    const personaConfig = personaConfigs?.get(persona);
    if (!personaConfig) {
      err.write(
        `warning: autostart persona '${persona}' has no resolved config — skipping\n`,
      );
      continue;
    }
    const account = personaConfig.channels.telegram;
    if (!account) {
      // A persona with no Telegram statement may autostart for PhantomChat
      // alone. A stated-but-incomplete account is different and must be loud,
      // while remaining non-fatal so PhantomChat and sibling bots stay alive.
      if (personaConfig.channels.telegramStated) {
        warnIncomplete(persona, "[channels.telegram]");
      }
      continue;
    }
    const agentDir = personaDir(config, persona);
    if (!existsSync(agentDir)) {
      err.write(
        `warning: autostart_personas lists '${persona}' but no agent dir at ${agentDir} — skipping\n`,
      );
      continue;
    }
    listeners.push({
      persona,
      agentDir,
      account,
      source: `autostart.${persona}`,
      config: personaConfig,
    });
  }

  for (const [persona, account] of Object.entries(
    config.channels.telegramPersonas ?? {},
  )) {
    // The legacy `[channels.telegram.personas.<name>]` table still works, but a
    // persona that already got a listener from its OWN config file must not get
    // a second one here. Migration COPIES rather than moves, so on a migrated
    // host the same bot is described in both places — without this skip the
    // duplicate-token guard below would read that as two personas fighting over
    // one bot and take Telegram down.
    //
    // Scoped to autostart-sourced listeners on purpose. A legacy entry that
    // names the DEFAULT persona is a different, long-supported shape (a second
    // bot bound to the same persona) and keeps working untouched. Config
    // layering removes only an entry proven to be the source of a migrated
    // default account before it reaches this planner.
    if (
      listeners.some(
        (l) => l.persona === persona && l.source === `autostart.${persona}`,
      )
    ) {
      continue;
    }
    const agentDir = personaDir(config, persona);
    if (!existsSync(agentDir)) {
      err.write(
        `warning: channels.telegram.personas.${persona} references persona '${persona}' but no agent dir at ${agentDir} — skipping\n`,
      );
      continue;
    }
    listeners.push({
      persona,
      agentDir,
      account,
      source: `personas.${persona}`,
      config: personaConfigs?.get(persona),
    });
  }

  for (const persona of config.channels.telegramPersonasStated ?? []) {
    if (config.channels.telegramPersonas?.[persona]) continue;
    warnIncomplete(
      persona,
      `[channels.telegram.personas.${persona}]`,
    );
  }

  // Duplicate-token guard. Two listeners on the same Telegram bot would
  // both call getUpdates(offset=...) — the second call's confirmation
  // would mark the first call's batch as read, dropping messages. Fail
  // loudly at startup rather than ship a flaky setup.
  const tokenOwner = new Map<string, string>();
  for (const l of listeners) {
    const prev = tokenOwner.get(l.account.token);
    if (prev) {
      return {
        listeners: [],
        fatal: `telegram: token reused by '${prev}' and '${l.source}'. Each persona needs its own bot (create a fresh one via @BotFather).`,
      };
    }
    tokenOwner.set(l.account.token, l.source);
  }

  return { listeners };
}

export async function runRun(input: RunInput = {}): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;

  let config = input.config ?? (await loadConfig());
  const hasDefault =
    !!config.channels.telegram || !!config.channels.telegramStated;
  const hasPersonas =
    (!!config.channels.telegramPersonas &&
      Object.keys(config.channels.telegramPersonas).length > 0) ||
    (config.channels.telegramPersonasStated?.length ?? 0) > 0;

  // PhantomChat personas are a runnable channel in their own right. Compute
  // this BEFORE the channel guards below: `phantombot init` now makes
  // PhantomChat the required primary channel and Telegram optional/skippable,
  // so a clean PhantomChat-only install has no [channels.telegram] but does
  // have one or more persona `phantomchat.json` files. Without accounting for
  // them here, runRun would exit at the Telegram guard and the freshly
  // installed service would die immediately on the advertised no-Telegram path.
  const allPhantomchatPersonas = listPhantomchatPersonas(config);
  const rosterDefault = config.defaultPersona;
  let phantomchatPersonas = selectPhantomchatPersonas(
    allPhantomchatPersonas,
    config,
    rosterDefault,
    err,
  );
  const hasPhantomchat = phantomchatPersonas.length > 0;

  if (!hasDefault && !hasPersonas && !hasPhantomchat) {
    err.write(
      "no channels configured. Run `phantombot telegram` and/or `phantombot phantomchat` to set one up.\n",
    );
    return 2;
  }

  // Heal the default persona BEFORE planning listeners — planListeners
  // checks agentDir existence, so we want a freshly-healed default
  // visible to it. Only relevant when the default account is configured;
  // a personas-only setup doesn't depend on defaultPersona's dir.
  let defaultPersona = config.defaultPersona;
  if (hasDefault) {
    const agentDir = personaDir(config, defaultPersona);
    if (!existsSync(agentDir)) {
      const healed = await healDefaultPersonaIfBroken(config, err);
      if (healed) {
        defaultPersona = healed;
        config.defaultPersona = healed;
      } else if (!hasPhantomchat) {
        err.write(
          `default persona '${defaultPersona}' not found at ${agentDir} and no other personas exist.\n` +
            "Create one with `phantombot persona`.\n",
        );
        return 2;
      }
      // else: Telegram's default persona is broken, but PhantomChat is a
      // runnable channel — fall through. planListeners skips the missing default
      // and we continue PhantomChat-only (warned below). The service must never
      // fail to start just because one channel is misconfigured.
    }
  }

  // The default persona may have been HEALED to a different name just above,
  // and the roster is anchored on it — recompute so the healed persona is not
  // gated out of its own PhantomChat listener.
  if (defaultPersona !== rosterDefault) {
    phantomchatPersonas = selectPhantomchatPersonas(
      allPhantomchatPersonas,
      config,
      defaultPersona,
      err,
    );
  }

  // Persona config migration + resolution (phantombot#439).
  //
  // Migration is copy-only and idempotent, so running it on every start is
  // safe and — crucially — order-independent: a host arriving from ANY older
  // version lands correct in one `/update`, with no "upgrade to X first"
  // dance. It also cannot change the config we already loaded: it only copies
  // keys the global file already has, and the merge gives the same answer
  // either way. So there is nothing to reload.
  const personaConfigs = new Map<string, Config>();
  const loadPersonaConfig =
    input.loadPersonaConfig ?? ((name: string) => loadConfig(name));
  const autostart = (config.autostartPersonas ?? []).filter(
    (name) => name !== defaultPersona,
  );
  try {
    const globalToml = await readConfigToml(config.configPath);
    const migrateNames = [
      defaultPersona,
      ...autostart,
      ...Object.keys(config.channels.telegramPersonas ?? {}),
      // PhantomChat-only personas have config of their own too (voice,
      // chattiness, harness chain); a persona that never had a Telegram bot
      // must still be migrated or it reads the default persona's settings
      // forever.
      ...phantomchatPersonas.map((spec) => spec.persona),
    ];
    for (const name of new Set(migrateNames)) {
      if (!existsSync(personaDir(config, name))) continue;
      await migratePersonaConfig({
        personasDir: config.personasDir,
        persona: name,
        globalToml,
        isDefault: name === defaultPersona,
      });
    }
  } catch (e) {
    // Never fatal. A persona that could not be seeded keeps reading the global
    // file exactly as it did before — degraded to the old behaviour, not broken.
    log.warn("run: persona config migration threw", {
      error: (e as Error).message,
    });
  }
  // Every persona this process will actually run needs its OWN effective
  // config — not just the Telegram autostart list. A PhantomChat persona left
  // out of this map falls back to `config`, i.e. the DEFAULT persona's voice,
  // chattiness and harness chain, which is precisely the silent mis-run #439
  // exists to remove.
  // LEGACY Telegram personas count too: a host still routing lena through
  // `[channels.telegram.personas.lena]` gets a listener, and a listener with no
  // resolved config falls back to `config` — the DEFAULT persona's harness
  // chain, voice, chattiness, retrieval and timeouts. That is the same silent
  // mis-run, just reached by the older road.
  const legacyTelegramNames = Object.keys(
    config.channels.telegramPersonas ?? {},
  ).filter((name) => name !== defaultPersona);
  const resolveNames = new Set<string>([
    ...autostart,
    ...legacyTelegramNames,
    ...phantomchatPersonas
      .map((spec) => spec.persona)
      .filter((name) => name !== defaultPersona),
  ]);
  for (const name of resolveNames) {
    // A legacy-routed persona with no config.toml of its own has nothing to
    // layer: the host file IS its whole configuration, exactly as before #439.
    // Loading a layer for it would be a no-op at best, so skip it and keep the
    // pre-#439 fallback. Once migration has seeded its file (it runs for every
    // legacy name above), this resolves like any other persona.
    if (
      !autostart.includes(name) &&
      !phantomchatPersonas.some((spec) => spec.persona === name) &&
      !existsSync(personaConfigPath(config.personasDir, name))
    ) {
      continue;
    }
    if (!existsSync(personaDir(config, name))) {
      // A legacy-routed persona with no dir is planListeners' business to
      // report (it already refuses to start a listener for a missing persona);
      // only an explicit autostart entry is worth a warning of its own here.
      if (autostart.includes(name)) {
        err.write(
          `warning: autostart_personas lists '${name}' but no persona dir at ${personaDir(config, name)} — skipping\n`,
        );
      }
      continue;
    }
    try {
      personaConfigs.set(name, await loadPersonaConfig(name));
    } catch (e) {
      err.write(
        `warning: could not load config for persona '${name}': ${(e as Error).message} — skipping\n`,
      );
    }
  }

  const plan = planListeners(config, defaultPersona, err, personaConfigs);
  if (plan.fatal) {
    err.write(`${plan.fatal}\n`);
    // Fatal only when Telegram is the sole channel. With PhantomChat available,
    // a broken Telegram config (e.g. a reused bot token) must NOT kill the
    // service — disable Telegram and continue PhantomChat-only. plan.listeners
    // is already [] here, so the rest of the flow runs without Telegram.
    if (!hasPhantomchat) return 2;
    err.write("  telegram disabled — continuing with phantomchat only.\n");
  }
  if (plan.listeners.length === 0 && !hasPhantomchat) {
    err.write(
      "no telegram listeners could be started — check the warnings above.\n",
    );
    return 2;
  }
  if (plan.listeners.length === 0 && (hasDefault || hasPersonas)) {
    // Telegram WAS configured but no listener could be planned (every bot's
    // persona dir is missing). PhantomChat still has runnable personas, so warn
    // loudly and keep going rather than killing the whole process.
    err.write(
      "warning: telegram is configured but no listener could start (persona missing) — continuing with phantomchat only.\n",
    );
  }

  let missingHarnessBins: HarnessAvailability[] = [];
  if (input.checkHarnesses !== false) {
    const resolution = await resolveHarnessBinsForConfig(config, {
      ...(input.checkHarnesses ? { check: input.checkHarnesses } : {}),
    });
    config = resolution.config;
    missingHarnessBins = resolution.missing;
  }
  if (missingHarnessBins.length > 0) {
    log.error("run: configured harness binary not found", {
      missing: missingHarnessBins.map((h) => ({ id: h.id, bin: h.bin })),
    });
    err.write(
      "warning: configured harness binary not found:\n" +
        missingHarnessBins
          .map((h) => `  ${h.id}: '${h.bin}'`)
          .join("\n") +
        "\nPhantombot will keep running; harness turns using these binaries will fail until doctor/config repairs them.\n",
    );
  }

  const harnesses = buildHarnessChain(config, err);
  if (harnesses.length === 0) {
    err.write(
      "no harnesses configured. Run `phantombot harness` to pick at least one.\n",
    );
    return 2;
  }

  // Resolve every Telegram listener before the daemon acquires its lock or
  // starts any channel. A typo in a persona override can otherwise produce an
  // empty chain for just that bot, leaving a listener that accepts messages
  // but fails every turn. Fail the whole startup and name the broken persona;
  // a partial multi-bot daemon is harder to diagnose than a clear boot error.
  const telegramListeners = plan.listeners.map((listener) => {
    // A listener resolves its harness chain from its OWN config when it has
    // one, so a persona can set `[harnesses].chain` in its own file. The bins
    // stay host-level — they name binaries installed on this machine, and were
    // just probed for real above — so they are carried over from the resolved
    // global config rather than re-probed per persona.
    const listenerConfig = withHostHarnessBins(listener.config ?? config, config);
    return {
      ...listener,
      config: listenerConfig,
      harnesses: buildHarnessChain(listenerConfig, err, listener.persona),
    };
  });
  const unusableTelegramListener = telegramListeners.find(
    (listener) => listener.harnesses.length === 0,
  );
  if (unusableTelegramListener) {
    err.write(
      `telegram persona '${unusableTelegramListener.persona}' has no usable harnesses. ` +
        "Fix its harness override or remove the override to use the global chain.\n",
    );
    return 2;
  }

  const lockPath = input.lockPath ?? defaultLockPath();
  const lock = acquireRunLock(lockPath);
  if (!isLockHandle(lock)) {
    if (input.ifNotRunning) {
      log.debug("run: already running, supervisor no-op", {
        holderPid: Number.isFinite(lock.pid) ? lock.pid : undefined,
      });
      return 0;
    }
    err.write(
      `phantombot is already running (pid ${Number.isFinite(lock.pid) ? lock.pid : "unknown"}; lock at ${lock.path})\n` +
        `view logs:    ${logsCommand()}\n` +
        `status:       ${await statusCommand()}\n` +
        "stop the other instance first, or remove the lock if it's stale.\n",
    );
    return 1;
  }

  // Windows self-update leaves the previous binary renamed aside as
  // `${exe}.old` (a running .exe can't be deleted, so the swap moves it out of
  // the way). It's unlocked once the old process has exited, so this freshly-
  // relaunched process sweeps it up. No-op on POSIX and best-effort — a
  // still-locked artifact is retried on the next boot. Gated to the real
  // compiled binary so `bun src/index.ts`/tests never touch the dev box.
  if (isPhantombotBinary()) {
    try {
      const removed = await cleanupStaleUpdateArtifacts(process.execPath);
      if (removed.length > 0) {
        log.info("run: removed stale self-update artifacts", { removed });
      }
    } catch (e) {
      log.warn("run: self-update artifact cleanup threw", {
        error: (e as Error).message,
      });
    }
  }

  // Windows only: reconcile the installed boot machinery with the version this
  // binary expects. If a self-update changed the boot-task shape, re-run the
  // idempotent install to migrate the tasks in place — so an update that
  // changes the boot method can't leave a box with stale, broken boot tasks.
  // Best-effort: a migration failure never blocks startup (the daemon is
  // already up; the heartbeat self-heal keeps patching drift meanwhile).
  if (isPhantombotBinary() && currentPlatform() === "windows") {
    try {
      const persona = await currentPersonaName();
      const result = await migrateBootSchemaIfNeeded({
        binPath: process.execPath,
        persona,
        schtasks: new BunSchtasksRunner(),
        out: { write: () => true },
        err: { write: () => true },
        readWindowsPassword: () => defaultReadVaultWindowsPassword(persona),
      });
      if (result.migrated) {
        log.info("run: migrated Windows boot schema", {
          from: result.from,
          to: result.to,
        });
      }
    } catch (e) {
      log.warn("run: boot-schema reconcile threw", {
        error: (e as Error).message,
      });
    }
  }

  const memory = await openMemoryStore(config.memoryDbPath);

  // The post-restart-notify hook uses the persona stored in a pending
  // `/update` marker when present, and falls back to this admin listener
  // for legacy markers. Prefer the default listener for that fallback;
  // use the first listener when no default account is configured.
  // Non-null: we returned above if plan.listeners.length === 0.
  // May be undefined on a PhantomChat-only install (no Telegram listeners).
  // The post-restart Telegram notify below is skipped in that case; doctor
  // falls back to a PhantomChat persona (then defaultPersona).
  const adminListener: ListenerSpec | undefined =
    plan.listeners.find((l) => l.source === "default") ?? plan.listeners[0];
  // Post-restart check: if `/update` wrote a pending-update marker before
  // we got SIGTERMed, surface the result to the chat that triggered it.
  // Runs once at startup; if no marker exists this is a quick no-op stat.
  // Logged + swallowed so a notify-send failure can't keep us out of the
  // poll loop — startup must always succeed. Skipped with no Telegram admin
  // listener: the post-restart notify path delivers over Telegram, so there's
  // no channel to send on (PhantomChat-only update-notify is a separate path).
  if (adminListener) {
    try {
      const r = await notifyPostRestartIfPending({
        config,
        currentVersion: VERSION,
        adminAccount: adminListener.account,
      });
      if (r.status === "success_notified" || r.status === "failure_notified") {
        log.info("run: post-restart notify", {
          status: r.status,
          targetTag: r.marker?.targetTag,
          previousVersion: r.marker?.previousVersion,
          currentVersion: VERSION,
        });
      }
    } catch (e) {
      log.warn("run: post-restart notify threw", {
        error: (e as Error).message,
      });
    }
  }

  // Harness health alerts (#284 follow-up). Failover is silent by design, so
  // a primary harness whose credential has died degrades to a paid fallback
  // with no signal anywhere but the provider's billing page — that is exactly
  // how Robbie spent 3.5 days on pi. Install a sender here, at the daemon,
  // where an owner channel actually exists; every other entry point (`ask`,
  // tick, tests) leaves the alerter unconfigured and therefore silent.
  //
  // Send through `runNotify` rather than a transport of our own: it is the
  // single writer that broadcasts across the persona bot, the default bot and
  // phantomchat (deduped), honours reply-mode, and — the part that matters
  // here — PERSISTS the alert into the conversation. Without that an owner
  // who replies "why did that fire?" is asking about a message no turn can
  // see.
  //
  // Persona resolution uses the same ladder as the startup doctor below: a
  // phantomchat-only install has no Telegram listener at all, and that is
  // precisely the kind of headless box where a dead credential goes unnoticed
  // for days. `runNotify` reaches phantomchat perfectly well, so gating on a
  // Telegram listener would switch the whole feature off exactly where it is
  // needed most.
  const alertPersona =
    adminListener?.persona ?? phantomchatPersonas[0]?.persona ?? defaultPersona;
  harnessAlerter.configure({
    host: hostname(),
    send: async (message: string) => {
      await runNotify({ config, message, persona: alertPersona });
    },
  });

  out.write(
    `phantombot — ${plan.listeners.length} telegram listener(s), ${phantomchatPersonas.length} phantomchat persona(s), harnesses ${config.harnesses.chain.join(" → ")}\n`,
  );
  for (const l of plan.listeners) {
    out.write(
      `  [${l.source}] persona '${l.persona}', long-poll ${l.account.pollTimeoutS}s, allowed users: ${
        l.account.allowedUserIds.length === 0
          ? "ANY (no allowlist)"
          : l.account.allowedUserIds.join(",")
      }\n`,
    );
  }
  // Gentle, one-time heads-up that semantic search is off. Embeddings are
  // optional — memory still works on OKF field-weighted BM25 with link-graph
  // expansion — so this is an informational line, not a warning, and never
  // blocks startup.
  const semanticSearch =
    config.embeddings?.provider === "gemini" &&
    !!config.embeddings?.gemini?.apiKey;
  if (!semanticSearch) {
    out.write(
      "  memory: semantic (vector) search OFF — OKF field-weighted BM25 + " +
        "link-graph expansion active. Optional: run `phantombot embedding` to add Gemini.\n",
    );
    // Threat screening itself does NOT depend on this key — the judge runs
    // on your PRIMARY harness (whichever of claude/pi/gemini/codex), which is
    // always present, so untrusted input is screened regardless. What the key
    // adds is the judge's BRIEFING recall (decisions/people/norms): without
    // embeddings the judge falls back to keyword-only recall (or none), which
    // is a quality degrade, not a security hole. Recommended for production so
    // the judge remembers what you've approved and what's routine.
    out.write(
      "  security: threat screening ACTIVE (runs on your primary harness). " +
        "Judge briefing recall is keyword-only without a Gemini key — run " +
        "`phantombot embedding` for semantic recall of rulings/contacts/norms.\n",
    );
  }
  out.write("Ctrl-C to stop.\n");

  // Startup health check — read-only for the nightly (it repairs itself by
  // sweeping); still repairs drifted units/timers/connectors. Don't await.
  // Runs against the admin persona for the same reason as notify above.
  runDoctor({ config, persona: alertPersona, personaConfigs, out, err }).then(
    (code) => {
      if (code !== 0) log.info("run: startup doctor flagged an issue", { code });
    },
    (e: unknown) =>
      log.error("run: startup doctor threw", {
        error: (e as Error).message,
      }),
  );

  // Startup nightly sweep — one of the two triggers that replaced the timer.
  // The nightly is idempotent (it processes whatever the ledger says is
  // unprocessed or changed, and no-ops when nothing is), so this is safe to
  // fire on every start: an always-on server finds nothing pending and exits
  // in milliseconds; a laptop booted at 09:15 distils the days it missed.
  // Detached, so a long backlog sweep outlives neither this promise nor the
  // daemon's own lifecycle concerns, and a crash there can never take the
  // channel loop with it.
  spawnStartupNightly(alertPersona);

  // Self-provision the managed Pi capability-routing extension: when a routable
  // capability (image and/or coding model) is configured, stamp the embedded
  // source + a routing.json baked from config into the owned
  // ~/.pi/agent/extensions/capability-routing/ dir; when none is configured,
  // remove any previously-stamped dir. Fire-and-forget so a slow or failing
  // filesystem never blocks startup. `doctor` re-stamps/removes on drift.
  // Gated to the real `phantombot` binary (same gate doctor uses for its
  // filesystem-touching checks) so `bun test`/dev never stamp the dev box's
  // real ~/.pi.
  if (isPhantombotBinary()) {
    ensureRoutingExtension(config.harnesses?.pi?.routing).then(
      (r) => {
        if (r.action !== "unchanged") {
          log.info("run: provisioned pi capability-routing extension", {
            action: r.action,
            dir: r.dir,
          });
        }
      },
      (e: unknown) =>
        log.warn("run: pi extension provision failed", {
          error: (e as Error).message,
        }),
    );
  }

  // Auto-register phantombot into any detected editor (Zed today; VS Code when
  // PR2 lands) so Andrew never has to run `acp install` by hand. Idempotent:
  // only writes when the registration is missing or points at a different
  // binary path (e.g. just updated), so it doesn't churn on every startup.
  // Fully error-isolated — `reconcileEditorConnectors` never throws and this is
  // best-effort, so a broken editor settings file can NEVER block startup or a
  // self-update. `doctor` re-reconciles on demand. Gated to the real
  // `phantombot` binary (same gate as the pi extension) so `bun run`/dev never
  // writes to the dev box's real ~/.config/zed.
  if (isPhantombotBinary()) {
    try {
      for (const r of reconcileEditorConnectors({
        binaryPath: process.execPath,
      })) {
        if (r.action === "registered" || r.action === "updated") {
          log.info("run: registered phantombot as ACP agent", {
            editor: r.editor,
            action: r.action,
            settings: r.settingsPath,
          });
        } else if (r.action === "error") {
          log.warn("run: editor connector registration failed", {
            editor: r.editor,
            error: r.error,
          });
        }
        // VS Code's proposed-api allow-list is a SEPARATE outcome from the
        // extension install — an extension can be `current` and still be
        // running degraded. Log it on its own axis so a silent fallback to the
        // `@phantombot` participant is visible in the daemon log.
        if (r.proposedApi === "enabled") {
          log.info("run: enabled VS Code proposed APIs", {
            editor: r.editor,
            note: "restart VS Code to activate",
          });
        } else if (r.proposedApi === "error") {
          log.warn("run: could not enable VS Code proposed APIs", {
            editor: r.editor,
            error: r.proposedApiError,
          });
        }
      }
    } catch (e) {
      // Defensive: reconcile is internally guarded, but startup must survive
      // anything here regardless.
      log.warn("run: editor connector reconcile threw", {
        error: (e as Error).message,
      });
    }
  }

  const ac = new AbortController();
  let forcedExit = false;
  const onSig = () => {
    ac.abort();
    // Graceful teardown drains the event loop naturally (run() sets
    // process.exitCode and returns — there is no process.exit()). But a relay
    // ws.close() on a half-open socket can leave the FD alive, keeping the loop
    // open until systemd's 90s SIGKILL. Arm a force-exit watchdog so a wedged
    // shutdown is bounded to the grace window instead. .unref() so a clean
    // shutdown (the common case) never waits on this timer — it exits on its
    // own in a few seconds. Memory is durable (SQLite/WAL) and the lock is a
    // stale-checked pidfile, so an abrupt exit(0) here is safe.
    if (forcedExit) return;
    forcedExit = true;
    armShutdownWatchdog(SHUTDOWN_GRACE_MS, () => {
      log.warn("run: graceful shutdown exceeded grace window — forcing exit", {
        graceMs: SHUTDOWN_GRACE_MS,
      });
      process.exit(0);
    });
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);

  // The roster /status reports: every persona this process really started,
  // Telegram and PhantomChat alike (phantombot#439).
  const runningPersonas = [
    ...new Set([
      ...telegramListeners.map((l) => l.persona),
      ...phantomchatPersonas.map((spec) => spec.persona),
    ]),
  ];

  try {
    // Fan-out: one listener per (persona, account). Shared AbortSignal
    // so Ctrl-C cleanly tears all of them down together.
    const startTelegram = input.runTelegramServer ?? runTelegramServer;
    const tasks = telegramListeners.map((l) =>
      startTelegram({
        config: l.config ?? config,
        memory,
        harnesses: l.harnesses,
        agentDir: l.agentDir,
        persona: l.persona,
        runningPersonas,
        account: l.account,
        transport: new HttpTelegramTransport(l.account.token),
        signal: ac.signal,
        out,
        err,
      }),
    );

    // phantomchat (Nostr NIP-17 DM) listeners — run ALONGSIDE Telegram. Fan-out
    // mirrors the Telegram one: each persona dir under personasDir that holds a
    // `phantomchat.json` (its OWN nsec + relays + allowlist) becomes its OWN
    // listener bound to that persona, with its OWN npub. No config.toml editing
    // and no shared env secret — the identity is self-contained in the persona
    // folder, so a copy/pasted persona just works.
    // phantomchatPersonas was computed up-front (it gates the no-Telegram
    // start path); reuse it here rather than re-scanning the persona dir.
    if (phantomchatPersonas.length > 0) {
      // Lazy import of SimplePool keeps the nostr-tools websocket machinery out
      // of the import graph for Telegram-only deployments. Tests inject
      // runPhantomchatServer (which ignores the channel it's handed), so the
      // SimplePool that gets built here is never actually driven by a test.
      const startPhantomchat =
        input.runPhantomchatServer ?? runPhantomchatServer;
      const { AuthGuardedSimplePool } = await import(
        "../channels/phantomchat/authGuardedPool.ts"
      );

      // Fetch the canonical relay list ONCE (single source of truth, served by
      // the PWA at /relays.json). Shared across every persona. null = fetch
      // failed → each persona falls back to its cached relays, then the seed.
      const canonicalRelays = await fetchCanonicalRelays();
      if (canonicalRelays) {
        out.write(
          `  [phantomchat] canonical relays: ${canonicalRelays.length} from /relays.json\n`,
        );
      } else {
        out.write(
          `  [phantomchat] /relays.json unavailable — using cached/seed relays per persona\n`,
        );
      }

      // The relay-free P2P node (phantombot#258). Each persona binds its OWN
      // OS-ephemeral loopback port (config.p2p.port defaults to 0), so every
      // persona on the host can run a node with zero port collisions and
      // advertise its real port under its own npub. On by default; see config.p2p.
      const p2pSettings = config.p2p ?? DEFAULT_P2P;

      for (const spec of phantomchatPersonas) {
        const personaConfig = withHostHarnessBins(
          personaConfigs.get(spec.persona) ?? config,
          config,
        );
        const personaHarnesses = buildHarnessChain(
          personaConfig,
          err,
          spec.persona,
        );
        if (personaHarnesses.length === 0) {
          err.write(
            `warning: phantomchat persona '${spec.persona}' has no usable harnesses — skipping\n`,
          );
          continue;
        }
        const { identity, allowedHex, relayHex, tofu, groupBots } = spec.config;

        // Group addressing (multi-bot groups). From the configured sibling bots
        // derive: the shared NAME roster (every bot's name + our own, so a bot
        // only replies when addressed by name / when it holds the thread) and
        // the sibling-bot HEX set (so a bot never reacts to another bot —
        // cascade kill, option (a)).
        const groupPersonaNames = [
          spec.persona,
          ...groupBots.map((b) => b.name),
        ];
        const siblingBotHex = groupBots.map((b) => b.hex);

        // Effective relays: canonical (if fetched) else the persona's cached
        // relays. When canonical differs from the cache, write it back so a
        // later offline start uses the freshest known-good set.
        const relays = canonicalRelays ?? spec.config.relays;
        if (canonicalRelays && !sameRelays(canonicalRelays, spec.config.relays)) {
          void cacheRelaysForPersona(spec.agentDir, canonicalRelays).catch((e) => {
            log.warn(`phantomchat[${spec.persona}]: relay cache write failed`, {
              error: (e as Error).message,
            });
          });
        }

        const openBot = allowedHex.length === 0 && tofu !== true;
        if (openBot) {
          // Empty allowlist with TOFU off = answer anyone. Warn loudly.
          log.warn(
            `phantomchat[${spec.persona}]: no allowed_npubs and TOFU off — ANYONE who DMs this persona will be answered`,
          );
          err.write(
            `warning: phantomchat persona '${spec.persona}' has no allowlist — anyone who DMs it will be answered. Set allowed_npubs via \`phantombot phantomchat --persona ${spec.persona}\`.\n`,
          );
        }
        const allowedLabel =
          allowedHex.length > 0
            ? String(allowedHex.length)
            : tofu === true
              ? "TOFU (trust first DM)"
              : "ANY (no allowlist)";
        out.write(
          `  [phantomchat:${spec.persona}] npub ${identity.npub}, ${relays.length} relay(s), allowed npubs: ${allowedLabel}\n`,
        );
        if (groupBots.length > 0) {
          out.write(
            `  [phantomchat:${spec.persona}] group roster: ${groupPersonaNames.join(", ")} (${groupBots.length} sibling bot(s) ignored in groups)\n`,
          );
        }
        if (relayHex.length > 0) {
          // Visible at startup on purpose: a relay npub is a standing hole in
          // the "only the principal talks to me" model, so the operator should
          // see it every boot rather than have to remember the config file.
          out.write(
            `  [phantomchat:${spec.persona}] relay npubs: ${relayHex.length} (untrusted tier — screened, no slash commands)\n`,
          );
        }
        // enablePing: nostr-tools sends a keepalive (ws ping, or a dummy REQ for
        // WebSocket impls without .ping()) every ~30s so an idle relay socket is
        // never closed for inactivity. This is the root fix for "the persona
        // ignores the first DM after it's been idle": without keepalive the relay
        // drops the idle socket, the gift-wrap subscription dies, and the first
        // message lands into a connection nobody is holding. We deliberately do
        // NOT set enableReconnect — on reconnect nostr-tools narrows each filter's
        // `since` to lastEmitted+1, which would silently drop gift-wraps whose
        // created_at is backdated up to 48h (NIP-59). Hard-drop recovery is
        // handled instead by the channel-layer self-heal watchdog, which re-arms
        // the subscription with our own correct wide `since`.
        //
        // NIP-42 (issue #368). A relay that sends an AUTH challenge — on
        // connect or mid-subscription — gets a signed kind-22242 response from
        // the persona's key. Without it, a `nip42_auth = true` relay silently
        // drops every event we publish. The guarded subclass also keeps an
        // unanswered challenge from crashing the daemon (issue #401).
        const pool = new AuthGuardedSimplePool(identity.secretKey, {
          enablePing: true,
        });
        const transport = new SimplePoolPhantomchatTransport(
          identity.secretKey,
          relays,
          pool as unknown as ConstructorParameters<
            typeof SimplePoolPhantomchatTransport
          >[2],
        );
        // The in-process P2P bridge (created only when P2P is enabled). It wires
        // the WebRTC node's inbound frames into the channel's ingest and tees
        // outbound replies to the node — replacing the retired ws LocalBridge, so
        // a headless persona actually terminates a conversation over WebRTC
        // instead of advertising a capability it can't honour (issue #61).
        const p2pBridge = p2pSettings.enabled ? new ChannelBridge() : undefined;
        if (p2pBridge) {
          transport.setPublishObserver((event) => p2pBridge.routeOutbound(event));
        }
        const channel = createPhantomchatChannel({
          secretKey: identity.secretKey,
          publicKeyHex: identity.publicKeyHex,
          transport,
          inboundSink: p2pBridge,
        });
        // Post-restart confirmation for a `/update` that was issued FROM
        // PhantomChat. The Telegram notify above deliberately deferred any
        // phantomchat-origin marker; this routes "✅ Updated to vX" back to the
        // exact DM it was typed in, over this persona's own relays. Best-effort
        // + detached so a relay hiccup never delays the listener coming up.
        void notifyPhantomchatPostRestart({
          persona: spec.persona,
          transport,
          currentVersion: VERSION,
        })
          .then((r) => {
            if (
              r.status === "success_notified" ||
              r.status === "failure_notified"
            ) {
              log.info("run: phantomchat post-restart notify", {
                status: r.status,
                persona: spec.persona,
                targetTag: r.marker?.targetTag,
              });
            }
          })
          .catch((e) =>
            log.warn(`phantomchat[${spec.persona}]: post-restart notify threw`, {
              error: (e as Error).message,
            }),
          );
        // Register/refresh this persona's public profile (NIP-01 kind 0) so the
        // PWA shows a real name ("Lena", not the npub) and badges it as a bot
        // (NIP-24 bot:true). kind 0 is replaceable, so this just supersedes the
        // prior one on each start. Detached + best-effort — a relay hiccup must
        // never delay the listener coming up.
        const displayName =
          spec.persona.charAt(0).toUpperCase() + spec.persona.slice(1);
        void transport
          // Advertise the same slash commands the channel handles (the
          // setMyCommands analogue) so the PWA can render the /-typeahead menu.
          .publishProfile({
            name: displayName,
            bot: true,
            commands: TELEGRAM_BOT_COMMANDS,
          })
          .then(() =>
            out.write(
              `  [phantomchat:${spec.persona}] published profile '${displayName}' (bot)\n`,
            ),
          )
          .catch((e) =>
            log.warn(`phantomchat[${spec.persona}]: profile publish failed`, {
              error: (e as Error).message,
            }),
          );
        // Presence was removed — the client no longer shows online/last-seen, so
        // we don't publish status heartbeats (saved bandwidth + the recipient's
        // gift-wrap crypto).
        const agentDir = spec.agentDir;
        tasks.push(
          startPhantomchat({
            config: personaConfig,
            memory,
            harnesses: personaHarnesses,
            agentDir,
            persona: spec.persona,
            runningPersonas,
            channel,
            secretKey: identity.secretKey,
            allowedHex,
            relayHex,
            groupPersonaNames,
            siblingBotHex,
            // Auto bot-detection + name resolution: the server fetches members'
            // kind-0 profiles to recognise sibling bots (NIP-24 `bot` flag) and
            // derive their addressing names, so multi-bot groups work with no
            // group_bots config (the static lists above are now just optional
            // seeds/overrides).
            fetchProfiles: (authors: string[]) => transport.fetchProfiles(authors),
            tofu,
            // TOFU commit: encode the proven sender hex → npub and persist it to
            // this persona's phantomchat.json (clearing tofu). Best-effort.
            persistTrust: async (senderHex: string) => {
              const npub = npubEncode(senderHex);
              await recordTrustedNpub(agentDir, npub);
              out.write(
                `  [phantomchat:${spec.persona}] TOFU trusted ${npub} — now locked\n`,
              );
            },
            signal: ac.signal,
            out,
            err,
          }).finally(() => {
            transport.close();
          }),
        );

        // Proactive onboarding: the bot reaches OUT to its allowlist instead of
        // waiting to be DM'd. Greet every allowed npub not yet in `greeted`,
        // then record it so restarts re-greet only npubs added since last time.
        // Runs DETACHED (not pushed to `tasks`) so a slow greeting generation
        // never delays startup or the relay subscription, and only fires when
        // there's pending work — a fully-onboarded persona costs nothing on
        // restart. TOFU/open-bot personas have an empty allowlist, so there's
        // nothing to greet and this is skipped.
        const greetedSet = new Set(spec.config.greeted);
        const pendingGreet = spec.config.allowedNpubs.filter(
          (n) => !greetedSet.has(n),
        );
        if (pendingGreet.length > 0) {
          const greetSpec = spec;
          void (async () => {
            const greeting = await resolvePersonaGreeting({
              agentDir,
              persona: greetSpec.persona,
              harnesses: personaHarnesses,
              idleTimeoutMs: config.harnessIdleTimeoutMs,
              hardTimeoutMs: config.harnessHardTimeoutMs,
              startupTimeoutMs: config.harnessStartupTimeoutMs,
              signal: ac.signal,
            });
            await greetPendingNpubs({
              persona: greetSpec.persona,
              allowedNpubs: greetSpec.config.allowedNpubs,
              greetedNpubs: greetSpec.config.greeted,
              greeting,
              sendMessage: (hex, text) => transport.sendMessage(hex, text),
              recordGreeted: async (npub) => {
                await recordGreeted(agentDir, npub);
              },
              out,
              err,
            });
          })().catch((e) => {
            log.warn(`phantomchat[${greetSpec.persona}]: greet pass failed`, {
              error: (e as Error).message,
            });
          });
        }

        // Relay-free P2P transport node. Rides THIS persona's identity, relays
        // and relay pool: werift WebRTC channels to peer nodes (NAT-traversed via
        // STUN), with Nostr carrying only the WebRTC handshake and acting as the
        // delivery fallback. Inbound frames terminate in THIS persona's channel
        // (via p2pBridge), replies tee back out over WebRTC. Inert unless
        // config.p2p.enabled (issue #61).
        if (p2pSettings.enabled && p2pBridge) {
          const p2pDeps = {
            secretKey: identity.secretKey,
            publicKeyHex: identity.publicKeyHex,
            relays,
            pool: pool as unknown as Parameters<typeof buildP2PNode>[0]["pool"],
            settings: p2pSettings,
            bridge: p2pBridge,
          };
          const p2pNode = buildP2PNode(p2pDeps);
          // Start SYNCHRONOUSLY and contain any startup throw inside the helper,
          // so a failed P2P bring-up degrades to relays instead of rejecting a
          // pushed task and aborting the whole `run` process. `advertise` fires
          // post-start (a single `{ webrtc: true }` capability advert).
          const p2pTask = startP2PNode({
            node: p2pNode,
            advertise: () => advertiseP2PCapability(p2pDeps),
            signal: ac.signal,
            out,
            err,
            persona: spec.persona,
          });
          if (p2pTask) tasks.push(p2pTask);
        }
      }
    }
    try {
      await Promise.all(tasks);
    } catch (e) {
      // One listener failed. The siblings are still polling against
      // the memory store + lock that `finally` is about to close. Abort
      // them and wait for them to settle so cleanup is race-free, then
      // re-raise so the caller (and exit code) sees the original error.
      log.error("run: a telegram listener failed — aborting siblings", {
        error: (e as Error).message,
      });
      ac.abort();
      const results = await Promise.allSettled(tasks);
      // Surface any additional rejections — they would otherwise be
      // silently swallowed since we only re-raise the first one.
      for (const r of results) {
        if (r.status !== "rejected") continue;
        const reason = r.reason as Error | undefined;
        // Skip the originally re-raised error (already logged above)
        // and AbortErrors triggered by our own ac.abort() — those are
        // expected during teardown, not independent failures.
        if (reason?.message === (e as Error)?.message) continue;
        if (reason?.name === "AbortError") continue;
        log.error("run: sibling listener also failed during teardown", {
          error: reason?.message,
        });
      }
      throw e;
    }
  } finally {
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
    await memory.close();
    lock.release();
  }
  return 0;
}

/**
 * Fire a detached `phantombot nightly` for the given persona at startup.
 *
 * Thin alias over the shared trigger (see src/lib/nightlyTrigger.ts) — startup
 * is one of the two events that replace the retired 02:00 timer; the heartbeat's
 * day-rollover check is the other. The nightly holds its own in-flight marker,
 * so a start-restart-start cycle cannot stack two sweeps on the same dates.
 */
export function spawnStartupNightly(persona: string): void {
  spawnNightlySweep(persona, "startup");
}

export default defineCommand({
  meta: {
    name: "run",
    description:
      "Run phantombot in the foreground (Telegram listener + harness loop). Ctrl-C to stop.",
  },
  args: {
    "if-not-running": {
      type: "boolean",
      description:
        "Exit successfully when another phantombot run already holds the lock (for supervisor keep-alive tasks).",
      default: false,
    },
  },
  async run({ args }) {
    const code = await runRun({ ifNotRunning: Boolean(args["if-not-running"]) });
    process.exitCode = code;
  },
});
