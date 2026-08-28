/**
 * The side-effecting half of the TUI.
 *
 * ## Changing a setting is an ACTION, not a write
 *
 * This is the rule the existing wizards get wrong and the reason this module
 * exists. `phantombot embedding` finishes by PRINTING a sentence telling you to
 * go and run `phantombot memory index --reembed`. Miss that line and your
 * phantom silently has an index that no longer matches its query encoder:
 * queries are scoped to the embedding SPACE (a fingerprint over
 * provider + model + dimensions + document prefix), so every vector written
 * under the old space becomes invisible and recall degrades to lexical with
 * nothing on screen looking broken.
 *
 * So every action here does three things in order:
 *
 *   1. **Declares its consequence before it runs** (`describeConsequence`), so
 *      the screen can state it at the point of choice rather than afterwards.
 *   2. **Performs the consequence itself** — re-embed, restart, listener
 *      rebuild — rather than printing an instruction.
 *   3. **Reports it finishing**, with real counts, so success is observed and
 *      not inferred from an absence of errors.
 *
 * Rule: **no screen may leave the system needing a follow-up command.**
 *
 * Every action reuses the function the equivalent subcommand calls
 * (`applyEmbeddingConfig`, `applyVoiceConfig`, `runMemoryIndex`,
 * `writeAutostartPersonas`, `setPersonaSecret`). None of them reimplements a
 * write — otherwise the CLI and the TUI drift and the CLI quietly becomes the
 * untested surface.
 */

import { type Config, personaDir } from "../config.ts";
import { applyEmbeddingConfig } from "../cli/embedding.ts";
import type { EmbeddingConfigUpdate } from "../cli/embedding.ts";
import { applyVoiceConfig } from "../cli/voice.ts";
import { runMemoryIndex } from "../cli/memory.ts";
import type { EmbedProgress } from "../lib/embedJob.ts";
import { writeAutostartPersonas } from "../lib/personaDefault.ts";
import { setPersonaSecret } from "../lib/vaultSecrets.ts";
import { openPersonaVault } from "../lib/vault.ts";
import { loadState, saveState } from "../state.ts";
import {
  defaultServiceControl,
  type ServiceControl,
} from "../lib/platform.ts";
import type { VoiceConfig } from "../lib/voice.ts";
import { embeddingSpaceForConfig } from "../lib/embeddingSpace.ts";
import type { WriteSink } from "../lib/io.ts";

/** What a pending change will do, stated before the user commits to it. */
export interface Consequence {
  /** One line, present tense: "re-embeds 12,904 chunks". */
  summary: string;
  /** Longer explanation for the confirm panel. */
  detail: string;
  /** True when the action runs a long job the user can leave and return to. */
  longRunning: boolean;
  /** True when the daemon has to restart for the change to take effect. */
  restarts: boolean;
}

export interface EmbeddingChange {
  next: EmbeddingConfigUpdate;
  /** Current chunk count, for the estimate. Undefined when unknown. */
  indexedChunks?: number;
}

/**
 * Does moving from `config`'s current embedding settings to `next` change the
 * SPACE — i.e. invalidate every stored vector?
 *
 * The document prefix is part of the fingerprint. The QUERY prefix is not, and
 * this is the one asymmetry the UI must respect: offering a re-embed after a
 * query-prefix change would burn a full index rebuild for no reason at all.
 */
export function embeddingSpaceChanges(
  config: Config,
  next: EmbeddingConfigUpdate,
): boolean {
  const before = embeddingSpaceForConfig(config);
  if (next.provider === "none") return before !== undefined;
  if (!before) return true;
  if (next.provider !== before.provider) return true;
  const nextModel =
    next.provider === "gemini"
      ? next.model
      : next.openaiCompatible?.model;
  const nextDims =
    next.provider === "gemini" ? next.dims : next.openaiCompatible?.dims;
  if (nextModel && nextModel !== before.model) return true;
  if (nextDims && nextDims !== before.dimensions) return true;
  if (
    next.provider === "openai-compatible" &&
    next.openaiCompatible?.documentPrefix !== undefined &&
    next.openaiCompatible.documentPrefix !== (before.documentPrefix ?? "")
  ) {
    return true;
  }
  return false;
}

export function describeEmbeddingChange(
  config: Config,
  change: EmbeddingChange,
): Consequence {
  if (!embeddingSpaceChanges(config, change.next)) {
    return {
      summary: "writes the setting; no re-embed needed",
      detail:
        "The embedding space is unchanged, so every stored vector stays " +
        "visible. (A query-prefix change lands here on purpose: the query " +
        "prefix is not part of the space fingerprint.)",
      longRunning: false,
      restarts: false,
    };
  }
  if (change.next.provider === "none") {
    return {
      summary: "turns embeddings off; vectors are kept, not deleted",
      detail:
        "Recall falls back to OKF field-weighted lexical search. Nothing is " +
        "erased — choosing the same provider, model and dimensions again " +
        "makes the existing vectors visible with no re-embed.",
      longRunning: false,
      restarts: false,
    };
  }
  const n = change.indexedChunks;
  return {
    summary: n
      ? `re-embeds ${n.toLocaleString()} chunks`
      : "re-embeds the whole index",
    detail:
      "This changes the embedding space fingerprint, so every existing " +
      "vector becomes invisible to search — queries are space-scoped. The " +
      "old vectors are kept until the rebuild finishes and recall stays on " +
      "lexical in the meantime, so nothing goes dark. This runs here; there " +
      "is no command to run afterwards.",
    longRunning: true,
    restarts: false,
  };
}

export interface ApplyEmbeddingInput {
  config: Config;
  persona: string;
  change: EmbeddingChange;
  onProgress?: (progress: EmbedProgress) => void;
  /** Collects the re-embed job's own output for the results panel. */
  out?: WriteSink;
  err?: WriteSink;
}

export interface ApplyEmbeddingResult {
  ok: boolean;
  reembedded: boolean;
  /** Non-empty when the re-embed reported a problem. */
  error?: string;
}

/**
 * Write the embedding settings, then — when the space changed — re-embed.
 *
 * The order matters: config first, then the rebuild, because `runMemoryIndex`
 * resolves the embedder from the CONFIG. A rebuild before the write would
 * re-embed into the space we are leaving.
 */
export async function applyEmbedding(
  input: ApplyEmbeddingInput,
): Promise<ApplyEmbeddingResult> {
  const needsReembed = embeddingSpaceChanges(input.config, input.change.next);
  await applyEmbeddingConfig(input.config.configPath, input.change.next);
  if (!needsReembed || input.change.next.provider === "none") {
    return { ok: true, reembedded: false };
  }
  const code = await runMemoryIndex({
    persona: input.persona,
    reembed: true,
    onProgress: input.onProgress,
    out: input.out,
    err: input.err,
  });
  return code === 0
    ? { ok: true, reembedded: true }
    : {
        ok: false,
        reembedded: true,
        error: `re-embed exited ${code}; recall is still on lexical`,
      };
}

export interface ApplyVoiceInputTui {
  config: Config;
  persona: string;
  voice: VoiceConfig;
  apiKey?: string;
  serviceControl?: ServiceControl;
}

export function describeVoiceChange(voice: VoiceConfig): Consequence {
  // `[voice] provider` is ONE key driving TWO capabilities. `transcribe()`
  // supports exactly elevenlabs (scribe) and openai (whisper-1); every other
  // provider returns "STT not supported". So azure_edge yields a phantom that
  // speaks but silently REJECTS every voice note sent to it — a nasty thing to
  // discover by sending one, and therefore something the screen has to say at
  // the point of choice rather than in a footnote.
  const speaksOnly = voice.provider === "azure_edge";
  return {
    summary: speaksOnly
      ? "speaks, but cannot hear — inbound voice notes will be rejected"
      : "validates the key, then restarts the voice listener",
    detail: speaksOnly
      ? "azure_edge needs no credential and is the fastest way to hear your " +
        "phantom, but speech-to-text is only implemented for openai " +
        "(whisper-1) and elevenlabs (scribe). Until one of those is " +
        "configured, every voice note you send is refused."
      : "The key is checked with one live call before anything is stored; a " +
        "key that fails validation never reaches the vault.",
    longRunning: false,
    restarts: true,
  };
}

export async function applyVoice(
  input: ApplyVoiceInputTui,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await applyVoiceConfig({
      configPath: input.config.configPath,
      config: input.config,
      persona: input.persona,
      voice: input.voice,
      apiKey: input.apiKey,
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const svc = input.serviceControl ?? defaultServiceControl();
  const r = await svc.restart();
  return r.ok ? { ok: true } : { ok: false, error: r.stderr ?? "restart failed" };
}

export function describeAutostartChange(
  persona: string,
  on: boolean,
): Consequence {
  return {
    summary: on
      ? `${persona} starts with the daemon`
      : `${persona} no longer starts at boot`,
    detail:
      "autostart_personas is a HOST setting, not a per-phantom one — it lives " +
      "in the global config.toml. It takes effect when the daemon next builds " +
      "its listeners, so the service is restarted for you.",
    longRunning: false,
    restarts: true,
  };
}

export async function applyAutostart(input: {
  config: Config;
  persona: string;
  on: boolean;
  serviceControl?: ServiceControl;
}): Promise<{ ok: boolean; list: string[]; error?: string }> {
  const current = new Set(input.config.autostartPersonas ?? []);
  if (input.on) current.add(input.persona);
  else current.delete(input.persona);
  const list = await writeAutostartPersonas(input.config, [...current]);
  const svc = input.serviceControl ?? defaultServiceControl();
  const r = await svc.restart();
  return r.ok
    ? { ok: true, list }
    : { ok: false, list, error: r.stderr ?? "restart failed" };
}

export function describeDefaultPersonaChange(
  from: string,
  to: string,
): Consequence {
  return {
    summary: `${to} takes over /update and /restart from ${from}`,
    detail:
      "The default persona owns the host-level slash commands. Reassigning it " +
      "moves control of updating and restarting this box to a different " +
      "phantom, and changes which persona a bare command targets.",
    longRunning: false,
    restarts: true,
  };
}

/**
 * Reassign the host-wide default persona.
 *
 * WRITES state.json, NOT config.toml. `config.ts` resolves the default as
 * `state.default_persona ?? globalToml.default_persona` — state WINS — so a
 * config-only write returns success and changes nothing on any host that has
 * ever created a persona, switched with `phantombot persona <name>`, or been
 * healed by `healDefaultPersonaIfBroken`. That is every host in practice.
 * `saveState` also emits the append-only `state-audit.log` record, which is how
 * the writer of a bad default stays identifiable after the fact.
 *
 * Mirrors `runSwitchDefault` (cli/persona.ts) deliberately, including its
 * refusal under `PHANTOMBOT_PERSONA`: a persona agent must not be able to
 * re-point the daemon-wide default, and the TUI is reachable from one.
 */
export async function applyDefaultPersona(input: {
  config: Config;
  persona: string;
  serviceControl?: ServiceControl;
}): Promise<{ ok: boolean; error?: string }> {
  const agentPersona = process.env.PHANTOMBOT_PERSONA?.trim();
  if (agentPersona) {
    return {
      ok: false,
      error:
        `refusing to switch default_persona to '${input.persona}': running as ` +
        `persona '${agentPersona}' (PHANTOMBOT_PERSONA).`,
    };
  }
  // Re-load rather than trusting a snapshot: another writer (harness_bins
  // discovery, the daemon) may have touched state while the confirm panel was
  // open, and writing a stale object would clobber its fields.
  const state = await loadState();
  if ((state.default_persona ?? input.config.defaultPersona) === input.persona) {
    return { ok: true };
  }
  state.default_persona = input.persona;
  await saveState(state);
  input.config.defaultPersona = input.persona;
  const svc = input.serviceControl ?? defaultServiceControl();
  const r = await svc.restart();
  return r.ok ? { ok: true } : { ok: false, error: r.stderr ?? "restart failed" };
}

/**
 * Store a secret in one persona's vault.
 *
 * The TUI never renders a value, so this is write-only from the app's point of
 * view: the keys screen lists NAMES and whether they are set, and setting one
 * prompts in a masked field whose contents are never echoed back into any
 * component state that a render could reach.
 */
export async function setSecret(input: {
  config: Config;
  persona: string;
  name: string;
  value: string;
}): Promise<{ ok: boolean; error?: string }> {
  const r = await setPersonaSecret(
    input.config,
    input.name,
    input.value,
    input.persona,
  );
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

export async function unsetSecret(input: {
  config: Config;
  persona: string;
  name: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const vault = await openPersonaVault(personaDir(input.config, input.persona));
    try {
      vault.unset(input.name);
    } finally {
      vault.close();
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function restartService(
  serviceControl?: ServiceControl,
): Promise<{ ok: boolean; error?: string }> {
  const svc = serviceControl ?? defaultServiceControl();
  const r = await svc.restart();
  return r.ok ? { ok: true } : { ok: false, error: r.stderr ?? "restart failed" };
}
