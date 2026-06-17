/**
 * `phantombot run` — long-running channel listener (Telegram for v1).
 * Stays in the foreground. Ctrl-C to stop. Daemonize via systemd
 * (`phantombot install`) or `nohup phantombot run &`.
 *
 * Replaces the older `phantombot serve --telegram`.
 */

import { defineCommand } from "citty";
import { existsSync } from "node:fs";

import {
  HttpTelegramTransport,
  runTelegramServer,
} from "../channels/telegram.ts";
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
import { npubEncode } from "../lib/nostrIdentity.ts";
import {
  type Config,
  loadConfig,
  personaDir,
  type TelegramAccount,
} from "../config.ts";
import { buildHarnessChain } from "../harnesses/buildChain.ts";
import {
  resolveHarnessBinsForConfig,
  type HarnessAvailability,
} from "../lib/harnessAvailability.ts";
import type { WriteSink } from "../lib/io.ts";
import { log } from "../lib/logger.ts";
import { healDefaultPersonaIfBroken } from "../lib/personaDefault.ts";
import { logsCommand, statusCommand } from "../lib/platform.ts";
import {
  acquireRunLock,
  defaultLockPath,
  isLockHandle,
} from "../lib/runLock.ts";
import { notifyPostRestartIfPending } from "../lib/updateNotify.ts";
import { openMemoryStore } from "../memory/store.ts";
import { VERSION } from "../version.ts";
import { runDoctor } from "./doctor.ts";

export interface RunInput {
  config?: Config;
  out?: WriteSink;
  err?: WriteSink;
  /** Override the lock file path (for testing). */
  lockPath?: string;
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
}

/** One persona-bound listener that runRun() will spawn. */
export interface ListenerSpec {
  persona: string;
  agentDir: string;
  account: TelegramAccount;
  /** "default" or "personas.<name>" — used in log/error messages. */
  source: string;
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
): { listeners: ListenerSpec[]; fatal?: string } {
  const listeners: ListenerSpec[] = [];

  if (config.channels.telegram) {
    const agentDir = personaDir(config, defaultPersona);
    if (existsSync(agentDir)) {
      listeners.push({
        persona: defaultPersona,
        agentDir,
        account: config.channels.telegram,
        source: "default",
      });
    } else {
      err.write(
        `warning: default persona '${defaultPersona}' agent dir missing at ${agentDir} — skipping default telegram listener\n`,
      );
    }
  }

  for (const [persona, account] of Object.entries(
    config.channels.telegramPersonas ?? {},
  )) {
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
    });
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
  const hasDefault = !!config.channels.telegram;
  const hasPersonas =
    !!config.channels.telegramPersonas &&
    Object.keys(config.channels.telegramPersonas).length > 0;

  // PhantomChat personas are a runnable channel in their own right. Compute
  // this BEFORE the channel guards below: `phantombot init` now makes
  // PhantomChat the required primary channel and Telegram optional/skippable,
  // so a clean PhantomChat-only install has no [channels.telegram] but does
  // have one or more persona `phantomchat.json` files. Without accounting for
  // them here, runRun would exit at the Telegram guard and the freshly
  // installed service would die immediately on the advertised no-Telegram path.
  const phantomchatPersonas = listPhantomchatPersonas(config);
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

  const plan = planListeners(config, defaultPersona, err);
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
      "no telegram listeners could be started — every configured bot's persona is missing.\n",
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

  const lockPath = input.lockPath ?? defaultLockPath();
  const lock = acquireRunLock(lockPath);
  if (!isLockHandle(lock)) {
    err.write(
      `phantombot is already running (pid ${Number.isFinite(lock.pid) ? lock.pid : "unknown"}; lock at ${lock.path})\n` +
        `view logs:    ${logsCommand()}\n` +
        `status:       ${statusCommand()}\n` +
        "stop the other instance first, or remove the lock if it's stale.\n",
    );
    return 1;
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
  // optional — memory still works on keyword (BM25) search — so this is an
  // informational line, not a warning, and never blocks startup.
  const semanticSearch =
    config.embeddings?.provider === "gemini" &&
    !!config.embeddings?.gemini?.apiKey;
  if (!semanticSearch) {
    out.write(
      "  memory: semantic (vector) search OFF — keyword search active. " +
        "Optional: run `phantombot embedding` to enable.\n",
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

  // Startup catch-up: `doctor` checks for a stale, failed, or partially
  // checkpointed nightly and, if found, spawns a detached
  // `nightly --resume` that picks up from the last good stage. This
  // covers machines powered off during the 02:00 window. Don't await —
  // doctor's repair is a detached child, so this returns immediately.
  // Runs against the admin persona for the same reason as notify above.
  const doctorPersona =
    adminListener?.persona ?? phantomchatPersonas[0]?.persona ?? defaultPersona;
  runDoctor({ config, persona: doctorPersona, out, err }).then(
    (code) => {
      if (code !== 0) log.info("run: startup doctor flagged an issue", { code });
    },
    (e: unknown) =>
      log.error("run: startup doctor threw", {
        error: (e as Error).message,
      }),
  );

  const ac = new AbortController();
  const onSig = () => ac.abort();
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);

  try {
    // Fan-out: one listener per (persona, account). Shared AbortSignal
    // so Ctrl-C cleanly tears all of them down together.
    const startTelegram = input.runTelegramServer ?? runTelegramServer;
    const tasks = plan.listeners.map((l) =>
      startTelegram({
        config,
        memory,
        harnesses,
        agentDir: l.agentDir,
        persona: l.persona,
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
      const { SimplePool } = await import("nostr-tools/pool");

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

      for (const spec of phantomchatPersonas) {
        const { identity, allowedHex, tofu } = spec.config;

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
        const pool = new SimplePool({ enablePing: true });
        const transport = new SimplePoolPhantomchatTransport(
          identity.secretKey,
          relays,
          pool as unknown as ConstructorParameters<
            typeof SimplePoolPhantomchatTransport
          >[2],
        );
        const channel = createPhantomchatChannel({
          secretKey: identity.secretKey,
          publicKeyHex: identity.publicKeyHex,
          transport,
        });
        // Register/refresh this persona's public profile (NIP-01 kind 0) so the
        // PWA shows a real name ("Lena", not the npub) and badges it as a bot
        // (NIP-24 bot:true). kind 0 is replaceable, so this just supersedes the
        // prior one on each start. Detached + best-effort — a relay hiccup must
        // never delay the listener coming up.
        const displayName =
          spec.persona.charAt(0).toUpperCase() + spec.persona.slice(1);
        void transport
          .publishProfile({ name: displayName, bot: true })
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
            config,
            memory,
            harnesses,
            agentDir,
            persona: spec.persona,
            channel,
            allowedHex,
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
              harnesses,
              idleTimeoutMs: config.harnessIdleTimeoutMs,
              hardTimeoutMs: config.harnessHardTimeoutMs,
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

export default defineCommand({
  meta: {
    name: "run",
    description:
      "Run phantombot in the foreground (Telegram listener + harness loop). Ctrl-C to stop.",
  },
  async run() {
    const code = await runRun();
    process.exitCode = code;
  },
});
