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
import {
  ClientMatrixTransport,
  createRealMatrixClient,
  runMatrixServer,
} from "../channels/matrix.ts";
import {
  type Config,
  loadConfig,
  matrixCryptoStoreDir,
  type MatrixAccount,
  personaDir,
  type TelegramAccount,
} from "../config.ts";
import { buildHarnessChain } from "../harnesses/buildChain.ts";
import {
  applyResolvedHarnessBins,
  checkConfiguredHarnesses,
  missingHarnesses,
  resolvedHarnessBins,
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
import { saveHarnessBins } from "../state.ts";
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
  /** Test seam for the Matrix listener. */
  runMatrixServer?: typeof runMatrixServer;
  /**
   * Test seam: build a Matrix transport for an account. Production builds a
   * real crypto-enabled SDK client; tests inject a fake so `run` doesn't touch
   * the network / WASM.
   */
  makeMatrixTransport?: (
    account: MatrixAccount,
    persona: string,
  ) => Promise<ClientMatrixTransport>;
}

/** One persona-bound Telegram listener that runRun() will spawn. */
export interface ListenerSpec {
  persona: string;
  agentDir: string;
  account: TelegramAccount;
  /** "default" or "personas.<name>" — used in log/error messages. */
  source: string;
}

/** One persona-bound Matrix listener that runRun() will spawn. */
export interface MatrixListenerSpec {
  persona: string;
  agentDir: string;
  account: MatrixAccount;
  /** "default" or "personas.<name>" — used in log/error messages. */
  source: string;
}

/**
 * Build the Matrix listeners to spawn — the Matrix mirror of planListeners.
 * `[channels.matrix]` → one listener bound to `defaultPersona`; each
 * `[channels.matrix.personas.<name>]` → a listener for that persona. Missing
 * persona dirs are dropped with a warn. Duplicate (homeserver+userId) logins
 * fail fast: two /sync loops on the same device would fight over the crypto
 * store + to-device queue.
 */
export function planMatrixListeners(
  config: Config,
  defaultPersona: string,
  err: WriteSink,
): { listeners: MatrixListenerSpec[]; fatal?: string } {
  const listeners: MatrixListenerSpec[] = [];

  if (config.channels.matrix) {
    const agentDir = personaDir(config, defaultPersona);
    if (existsSync(agentDir)) {
      listeners.push({
        persona: defaultPersona,
        agentDir,
        account: config.channels.matrix,
        source: "default",
      });
    } else {
      err.write(
        `warning: default persona '${defaultPersona}' agent dir missing at ${agentDir} — skipping default matrix listener\n`,
      );
    }
  }

  for (const [persona, account] of Object.entries(
    config.channels.matrixPersonas ?? {},
  )) {
    const agentDir = personaDir(config, persona);
    if (!existsSync(agentDir)) {
      err.write(
        `warning: channels.matrix.personas.${persona} references persona '${persona}' but no agent dir at ${agentDir} — skipping\n`,
      );
      continue;
    }
    listeners.push({ persona, agentDir, account, source: `personas.${persona}` });
  }

  // Duplicate-device guard: a (homeserver, userId, deviceId) identity may only
  // back ONE /sync loop. Reusing it across two listeners corrupts the shared
  // crypto store.
  const seen = new Map<string, string>();
  for (const l of listeners) {
    const key = `${l.account.homeserver}|${l.account.userId}|${l.account.deviceId}`;
    const prev = seen.get(key);
    if (prev) {
      return {
        listeners: [],
        fatal: `matrix: device identity ${l.account.userId} (${l.account.deviceId}) reused by '${prev}' and '${l.source}'. Each persona needs its own Matrix login.`,
      };
    }
    seen.set(key, l.source);
  }

  return { listeners };
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
  const hasMatrix =
    !!config.channels.matrix ||
    (!!config.channels.matrixPersonas &&
      Object.keys(config.channels.matrixPersonas).length > 0);
  if (!hasDefault && !hasPersonas && !hasMatrix) {
    err.write(
      "no chat channel configured. Run `phantombot chat telegram` or `phantombot chat matrix` to set one up.\n",
    );
    return 2;
  }

  // Heal the default persona BEFORE planning listeners — planListeners
  // checks agentDir existence, so we want a freshly-healed default
  // visible to it. Only relevant when the default account is configured;
  // a personas-only setup doesn't depend on defaultPersona's dir.
  let defaultPersona = config.defaultPersona;
  if (hasDefault || !!config.channels.matrix) {
    const agentDir = personaDir(config, defaultPersona);
    if (!existsSync(agentDir)) {
      const healed = await healDefaultPersonaIfBroken(config, err);
      if (healed) {
        defaultPersona = healed;
        config.defaultPersona = healed;
      } else {
        err.write(
          `default persona '${defaultPersona}' not found at ${agentDir} and no other personas exist.\n` +
            "Create one with `phantombot persona`.\n",
        );
        return 2;
      }
    }
  }

  const plan = planListeners(config, defaultPersona, err);
  if (plan.fatal) {
    err.write(`${plan.fatal}\n`);
    return 2;
  }
  const matrixPlan = planMatrixListeners(config, defaultPersona, err);
  if (matrixPlan.fatal) {
    err.write(`${matrixPlan.fatal}\n`);
    return 2;
  }
  if (plan.listeners.length === 0 && matrixPlan.listeners.length === 0) {
    err.write(
      "no listeners could be started — every configured channel's persona is missing.\n",
    );
    return 2;
  }

  const harnessChecks =
    input.checkHarnesses === false
      ? []
      : input.checkHarnesses
        ? await input.checkHarnesses(config)
        : await checkConfiguredHarnesses(config);
  if (input.checkHarnesses !== false) {
    const resolved = resolvedHarnessBins(harnessChecks);
    if (Object.keys(resolved).length > 0) {
      await saveHarnessBins(resolved);
      config = applyResolvedHarnessBins(config, harnessChecks);
    }
  }
  const missingHarnessBins = missingHarnesses(harnessChecks);
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
  // use the first listener when no default account is configured. The
  // `/update` marker is ONLY written by Telegram's slash handler (Matrix has
  // no slash commands in v1), so when there's no Telegram listener at all
  // (Matrix-only setup) there's nothing to surface — skip the hook.
  const adminListener: ListenerSpec | undefined =
    plan.listeners.find((l) => l.source === "default") ?? plan.listeners[0];
  // Post-restart check: if `/update` wrote a pending-update marker before
  // we got SIGTERMed, surface the result to the chat that triggered it.
  // Runs once at startup; if no marker exists this is a quick no-op stat.
  // Logged + swallowed so a notify-send failure can't keep us out of the
  // poll loop — startup must always succeed.
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
    `phantombot — ${plan.listeners.length} telegram + ${matrixPlan.listeners.length} matrix listener(s), harnesses ${config.harnesses.chain.join(" → ")}\n`,
  );
  for (const l of plan.listeners) {
    out.write(
      `  [telegram:${l.source}] persona '${l.persona}', long-poll ${l.account.pollTimeoutS}s, allowed users: ${
        l.account.allowedUserIds.length === 0
          ? "ANY (no allowlist)"
          : l.account.allowedUserIds.join(",")
      }\n`,
    );
  }
  for (const l of matrixPlan.listeners) {
    out.write(
      `  [matrix:${l.source}] persona '${l.persona}', ${l.account.userId}, allowed users: ${
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
  // Runs against the admin persona for the same reason as notify above. Falls
  // back to the first Matrix listener's persona (or the default persona) when
  // there's no Telegram listener.
  const doctorPersona =
    adminListener?.persona ??
    matrixPlan.listeners.find((l) => l.source === "default")?.persona ??
    matrixPlan.listeners[0]?.persona ??
    defaultPersona;
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
    // Fan-out: one listener per (persona, account), Telegram AND Matrix.
    // Shared AbortSignal so Ctrl-C cleanly tears all of them down together.
    const startTelegram = input.runTelegramServer ?? runTelegramServer;
    const startMatrix = input.runMatrixServer ?? runMatrixServer;
    // Default Matrix transport factory: a real crypto-enabled SDK client whose
    // crypto store lives in the persona dir (so it migrates with the persona).
    const makeMatrixTransport =
      input.makeMatrixTransport ??
      (async (account: MatrixAccount, persona: string) =>
        new ClientMatrixTransport(
          await createRealMatrixClient({
            homeserver: account.homeserver,
            userId: account.userId,
            deviceId: account.deviceId,
            accessToken: account.accessToken,
            cryptoStoreDir: matrixCryptoStoreDir(config, persona),
            e2ee: account.e2ee,
          }),
        ));
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
    // Matrix listeners. Building the transport is async (login-less client +
    // crypto init), so each is wrapped in an async IIFE that resolves the
    // transport then runs the server — keeping the fan-out uniform.
    const matrixTasks = matrixPlan.listeners.map((l) =>
      (async () => {
        const transport = await makeMatrixTransport(l.account, l.persona);
        await startMatrix({
          config,
          memory,
          harnesses,
          agentDir: l.agentDir,
          persona: l.persona,
          account: l.account,
          transport,
          signal: ac.signal,
          out,
          err,
        });
      })(),
    );
    tasks.push(...matrixTasks);
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
