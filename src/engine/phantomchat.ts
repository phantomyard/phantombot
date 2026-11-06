/**
 * The PhantomChat channel, hosted by the embeddable engine.
 *
 * The same listener `phantombot run` starts for a persona with a
 * `phantomchat.json` — own npub, own relays, own allowlist, NIP-17 DMs — but
 * owned by an application: started and stopped per persona, with a status
 * feed. What it leaves out on purpose:
 *
 *   - Process lifecycle. /update, /restart and /model's restart act on the
 *     `phantombot run` service; here they are refused (`embedded`).
 *   - Open bots. A persona with no allowlist (or only trust-on-first-use)
 *     does not start: an app-hosted persona always has a principal.
 *   - The onboarding greeting, post-update notices and the P2P node. The app
 *     that hosts the persona already knows its principal and talks over relays.
 *
 * The allowlist is read at start. `allow` / `disallow` restart a running
 * channel so a change applies at once.
 */

import {
  loadPhantomchatPersonaConfig,
  recordTrustedNpub,
  savePhantomchatPersonaConfig,
} from "../channels/phantomchat/personaStore.ts";
import { createVoiceModelsHandler } from "../channels/phantomchat/voiceModels.ts";
import { createPhantomchatChannel } from "../channels/phantomchat/channel.ts";
import { runPhantomchatServer } from "../channels/phantomchat/server.ts";
import { SimplePoolPhantomchatTransport } from "../channels/phantomchat/transport.ts";
import { TELEGRAM_BOT_COMMANDS } from "../channels/commands.ts";
import { allowPhantomchatNpub, parseRelays } from "../cli/phantomchat.ts";
import type { Config } from "../config.ts";
import type { Harness } from "../harnesses/types.ts";
import type { WriteSink } from "../lib/io.ts";
import type { ServiceControl } from "../lib/platform.ts";
import { log } from "../lib/logger.ts";
import { decodeNpubToHex, identityFromNsec, npubEncode } from "../lib/nostrIdentity.ts";
import { readPersonaIdentityNsec } from "../lib/personaIdentity.ts";
import type { MemoryStore } from "../memory/store.ts";
import { EngineError } from "./errors.ts";
import type { PhantomchatInfo, PhantomchatStartOptions, PhantomchatStatus } from "./types.ts";

/** @internal Read-only: never mints a key. */
export function phantomchatInfo(agentDir: string): PhantomchatInfo {
  const pc = loadPhantomchatPersonaConfig(agentDir);
  if (pc) {
    return { npub: pc.identity.npub, configured: true, allowedNpubs: [...pc.allowedNpubs] };
  }
  let npub: string | null = null;
  try {
    const nsec = readPersonaIdentityNsec(agentDir);
    if (nsec) npub = identityFromNsec(nsec).npub;
  } catch {
    npub = null;
  }
  return { npub, configured: false, allowedNpubs: [] };
}

/** @internal */
export function checkRelays(relays: unknown, name = "relays"): string[] | undefined {
  if (relays === undefined) return undefined;
  if (
    !Array.isArray(relays) ||
    relays.length === 0 ||
    relays.some((r) => typeof r !== "string") ||
    parseRelays((relays as string[]).join(" ")).length !== relays.length
  ) {
    throw new EngineError("invalid_argument", `${name} must be a non-empty list of wss:// or ws:// URLs`);
  }
  return [...(relays as string[])];
}

/** @internal */
export async function allowNpub(
  agentDir: string,
  npub: string,
  relays: string[] | undefined,
): Promise<{ npub: string; added: boolean }> {
  if (typeof npub !== "string") {
    throw new EngineError("invalid_argument", "npub must be a string");
  }
  try {
    const r = await allowPhantomchatNpub({
      agentDir,
      npub,
      fetchRelays: relays ? async () => relays : undefined,
    });
    return { npub: r.npub, added: r.added };
  } catch (e) {
    const message = (e as Error).message;
    if (message.startsWith("not a valid npub")) {
      throw new EngineError("invalid_argument", message);
    }
    throw new EngineError("write_failed", message);
  }
}

/** @internal */
export async function disallowNpub(agentDir: string, npub: string): Promise<boolean> {
  let hex: string;
  try {
    if (typeof npub !== "string" || !npub.trim().startsWith("npub1")) throw new Error();
    hex = decodeNpubToHex(npub.trim()).toLowerCase();
  } catch {
    throw new EngineError("invalid_argument", `not a valid npub: ${String(npub)}`);
  }
  const pc = loadPhantomchatPersonaConfig(agentDir);
  if (!pc) return false;
  const keep = pc.allowedNpubs.filter((n, i) => pc.allowedHex[i] !== hex && decodeSafe(n) !== hex);
  if (keep.length === pc.allowedNpubs.length) return false;
  if (keep.length === 0) {
    // An empty allowlist is an open bot (or TOFU) to every other reader of
    // this file. Removing the principal is deleting the persona.
    throw new EngineError(
      "invalid_argument",
      "cannot remove the last allowed npub; delete the persona instead",
    );
  }
  await savePhantomchatPersonaConfig(agentDir, {
    nsec: pc.identity.nsec,
    relays: pc.relays,
    allowedNpubs: keep,
    tofu: false,
  });
  return true;
}

function decodeSafe(npub: string): string | undefined {
  try {
    return decodeNpubToHex(npub).toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Belt-and-braces for the POSIX supervisor only: a path that reaches
 * `serviceControl` gets a refusal instead of bouncing the host's
 * `phantombot run`. It does NOT cover Windows, where `selfRestart` exits the
 * process without consulting `serviceControl`. The real guarantee is
 * `embedded`: `handleSlashCommand` refuses the lifecycle commands, and
 * `restartSelf` (the only slash-command route to `selfRestart`) refuses too.
 */
const NO_SERVICE_CONTROL = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === "then") return undefined; // never look like a promise
      if (prop === "isActive") return async () => false;
      return async () => ({ ok: false, stderr: "not available in the embedded engine" });
    },
  },
) as ServiceControl;

/** @internal */
export interface HostedChannel {
  stop(): Promise<void>;
}

/** @internal */
export interface StartChannelInput {
  persona: string;
  agentDir: string;
  config: Config;
  memory: MemoryStore;
  harnesses: Harness[];
  options: PhantomchatStartOptions;
  /** Runs `fn` inside the engine scope for this persona. */
  run: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Registers the channel so engine.close() stops it; returns untrack. */
  track: (controller: AbortController) => () => void;
  sink: WriteSink;
  onStatus: (status: PhantomchatStatus) => void;
  /** Test seam: the relay pool. Production builds an AuthGuardedSimplePool. */
  makePool?: (secretKey: Uint8Array) => unknown;
}

/**
 * @internal Start the listener. Resolves once it is running; the returned handle stops
 * it. A later failure (the server loop throws) is reported through
 * `onStatus` as "failed".
 */
export async function startHostedChannel(input: StartChannelInput): Promise<HostedChannel> {
  const spec = loadPhantomchatPersonaConfig(input.agentDir);
  if (!spec) {
    throw new EngineError(
      "not_configured",
      `persona '${input.persona}' has no PhantomChat allowlist; call phantomchat.allow(npub) first`,
    );
  }
  if (spec.allowedHex.length === 0) {
    throw new EngineError(
      "not_configured",
      `persona '${input.persona}' has an empty PhantomChat allowlist; call phantomchat.allow(npub) first`,
    );
  }
  const relays = checkRelays(input.options.relays) ?? spec.relays;
  const displayName =
    input.options.displayName?.trim() ||
    input.persona.charAt(0).toUpperCase() + input.persona.slice(1);
  const { identity, allowedHex, relayHex, groupBots } = spec;

  let pool: unknown;
  if (input.makePool) {
    pool = input.makePool(identity.secretKey);
  } else {
    const { AuthGuardedSimplePool } = await import("../channels/phantomchat/authGuardedPool.ts");
    pool = new AuthGuardedSimplePool(identity.secretKey, { enablePing: true });
  }
  const transport = new SimplePoolPhantomchatTransport(
    identity.secretKey,
    relays,
    pool as ConstructorParameters<typeof SimplePoolPhantomchatTransport>[2],
  );
  const channel = createPhantomchatChannel({
    secretKey: identity.secretKey,
    publicKeyHex: identity.publicKeyHex,
    transport,
    voiceModels: createVoiceModelsHandler({persona: input.persona, config: input.config,
      allowedNpubs: spec.allowedNpubs, secretKey: identity.secretKey,
      publish: event => transport.publishWrap(event)}),
  });
  void transport
    .publishProfile({ name: displayName, bot: true, commands: TELEGRAM_BOT_COMMANDS })
    .catch((e) =>
      log.warn(`engine: phantomchat[${input.persona}] profile publish failed`, {
        error: (e as Error).message,
      }),
    );

  const controller = new AbortController();
  const untrack = input.track(controller);
  const status = (s: PhantomchatStatus) => input.onStatus({ npub: identity.npub, ...s });
  let stopping = false;
  const done = input
    .run(() =>
      runPhantomchatServer({
        config: input.config,
        memory: input.memory,
        harnesses: input.harnesses,
        agentDir: input.agentDir,
        persona: input.persona,
        runningPersonas: [input.persona],
        lifecycleAccounts: [],
        channel,
        secretKey: identity.secretKey,
        allowedHex,
        relayHex,
        groupPersonaNames: [input.persona, ...groupBots.map((b) => b.name)],
        siblingBotHex: groupBots.map((b) => b.hex),
        fetchProfiles: (authors) => transport.fetchProfiles(authors),
        tofu: false,
        persistTrust: async (senderHex) => {
          // Unreachable with tofu off; kept so the server never writes a
          // trusted npub anywhere but this persona's file.
          await recordTrustedNpub(input.agentDir, npubEncode(senderHex));
        },
        embedded: true,
        serviceControl: NO_SERVICE_CONTROL,
        signal: controller.signal,
        out: input.sink,
        err: input.sink,
      }),
    )
    .then(
      () => status({ state: "stopped" }),
      (e: unknown) => {
        if (stopping) status({ state: "stopped" });
        else status({ state: "failed", error: e instanceof Error ? e.message : String(e) });
      },
    )
    .finally(() => {
      try {
        transport.close();
      } catch {
        /* best-effort */
      }
      untrack();
    });

  status({ state: "running", relays: relays.length });
  return {
    async stop() {
      stopping = true;
      controller.abort();
      await done;
    },
  };
}
