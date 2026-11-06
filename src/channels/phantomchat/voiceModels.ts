/** Authenticated, encrypted model-only configuration. Credentials never cross the relay. */
import { loadConfig, type Config } from "../../config.ts";
import { voiceApiKey, voiceForDirection } from "../../lib/audio.ts";
import { checkVoice } from "../../engine/voice.ts";
import { updateConfigToml, setIn } from "../../lib/configWriter.ts";
import { personaConfigPath } from "../../lib/personaConfig.ts";
import { decodeNpubToHex } from "../../lib/nostrIdentity.ts";
import { createRumor, createSeal, createGiftWrap, type NTNostrEvent } from "../../lib/nostrCrypto.ts";

export const VOICE_MODELS_TAG = "phantomchat-voice-models";
export function isVoiceModelsRumor(rumor: {tags?: unknown}): boolean {
  const tags = rumor.tags;
  return Array.isArray(tags) && tags.some(t => Array.isArray(t) && t[0] === VOICE_MODELS_TAG && t[1] === "1") &&
    tags.some(t => Array.isArray(t) && t[0] === "control" && t[1] === "true");
}

export type VoiceModelsHandler = ((rumor: {pubkey: string; created_at: number; content: string}) => Promise<void> | undefined) & {close(): Promise<void>};

export function createVoiceModelsHandler(input: {
  persona: string; config: Config; allowedNpubs: string[];
  secretKey: Uint8Array; publish(event: NTNostrEvent): Promise<unknown>;
}) {
  const allowed = new Set(input.allowedNpubs.map(n => decodeNpubToHex(n)?.toLowerCase()));
  let queue = Promise.resolve();
  let pending = 0;
  let closed = false;
  const handler = (rumor: {pubkey: string; created_at: number; content: string}) => {
    if (closed || !allowed.has(rumor.pubkey.toLowerCase()) || Math.abs(Date.now() / 1000 - rumor.created_at) > 60 || rumor.content.length > 8192) return;
    // Bounded, serialized configuration; never an LLM turn or a general RPC.
    let request: any;
    try { request = JSON.parse(rumor.content); } catch { return; }
    if (request?.type !== VOICE_MODELS_TAG || !/^[a-zA-Z0-9-]{1,64}$/.test(request.id) || !["get", "set"].includes(request.method)) return;
    if (pending >= 4) return;
    pending++;
    queue = queue.then(async () => {
      if (closed) return;
      const reply: any = {type: VOICE_MODELS_TAG, id: request.id};
      try {
        if (Math.abs(Date.now() / 1000 - rumor.created_at) > 60) throw new Error("Voice request expired");
        const config = await loadConfig(input.persona);
        const state: Record<string, any> = {};
        const changes: Array<{d: "tts" | "stt"; settings: Record<string, unknown>}> = [];
        for (const d of ["tts", "stt"] as const) {
          const direction = config.voice[d];
          const effective = voiceForDirection(direction ? {...config, voice: {...config.voice, [d]: {...direction, enabled: true}}} : config, d);
          const v = effective.voice;
          const key = await voiceApiKey(effective);
          const selected = request.models?.[d];
          if (request.method === "set" && selected?.enabled === false) {
            const retained: Record<string, unknown> = {enabled: false};
            if (!direction && key && (v.provider === "openai-compatible" || v.provider === "elevenlabs")) {
              retained.provider = v.provider;
              retained.key_env = v.keyEnv ?? v.openaiCompatible?.keyEnv ?? "PHANTOMBOT_ELEVENLABS_API_KEY";
              retained.model = v.provider === "openai-compatible" ? (d === "tts" ? v.openaiCompatible!.ttsModel : v.openaiCompatible!.sttModel) : (d === "tts" ? v.elevenlabs!.modelId : "scribe_v1");
              if (v.openaiCompatible) retained.base_url = v.openaiCompatible.baseUrl;
              if (d === "tts") retained.voice = v.openaiCompatible?.voice ?? v.elevenlabs?.voiceId ?? "";
            }
            changes.push({d, settings: retained});
            state[d] = {available: !!key, enabled: false};
            continue;
          }
          const provider = v.provider;
          const baseUrl = provider === "openai-compatible" ? v.openaiCompatible?.baseUrl ?? "" : "";
          const model = provider === "openai-compatible" ? (d === "tts" ? v.openaiCompatible?.ttsModel : v.openaiCompatible?.sttModel) : (d === "tts" ? v.elevenlabs?.modelId : direction?.model ?? "scribe_v1");
          if (!key || (provider !== "openai-compatible" && provider !== "elevenlabs")) {
            if (request.method === "set" && selected?.enabled) throw new Error("Remote voice provider needs configuring");
            state[d] = {available: false}; continue;
          }
          const check = await checkVoice({modality: d, provider, baseUrl, apiKey: key, model: selected?.model ?? model});
          const existingVoice = provider === "openai-compatible" ? v.openaiCompatible?.voice : v.elevenlabs?.voiceId;
          state[d] = {available: check.ok, enabled: direction?.enabled ?? true, provider, baseUrl, model, models: check.models, voices: check.voices};
          if (request.method === "set" && selected) {
            if (selected.enabled !== true || !check.ok || selected.provider !== provider || typeof selected.baseUrl !== "string" || selected.baseUrl.replace(/\/+$/, "") !== baseUrl.replace(/\/+$/, "")) throw new Error("Incompatible remote voice settings");
            if (!check.models.some(m => m.id === selected.model) && selected.model !== model) throw new Error("Remote engine does not offer this model");
            const voice = check.voices.includes(existingVoice ?? "") ? existingVoice! : check.voices[0];
            if (d === "tts" && !voice) throw new Error("Remote model has no supported voice");
            if (d === "tts" && voice && !check.models.find(m => m.id === selected.model)?.voices.includes(voice)) {
              const proof = await checkVoice({modality: d, provider, baseUrl, apiKey: key, model: selected.model, voice});
              if (!proof.ok) throw new Error("Remote model rejected this voice");
            }
            changes.push({d, settings: {enabled: true, provider, model: selected.model,
              key_env: direction?.keyEnv ?? v.keyEnv ?? v.openaiCompatible?.keyEnv ?? "PHANTOMBOT_ELEVENLABS_API_KEY",
              ...(baseUrl ? {base_url: baseUrl} : {}), ...(d === "tts" ? {voice} : {})}});
            state[d].model = selected.model;
            state[d].enabled = true;
          }
        }
        if (request.method === "set") {
          if (!changes.length) throw new Error("No compatible voice models to apply");
          const target = personaConfigPath(config.personasDir, input.persona);
          if (closed) return;
          await updateConfigToml(target, toml => {
            for (const {d, settings} of changes) {
              for (const [key, value] of Object.entries(settings)) setIn(toml, ["voice", d, key], value);
            }
          });
          input.config.voice = (await loadConfig(input.persona)).voice;
        }
        reply.ok = true; reply.value = state;
      } catch {reply.ok = false; reply.error = "Remote voice configuration failed; check provider compatibility and the remote engine's vault";}
      const tags = [["p", rumor.pubkey], [VOICE_MODELS_TAG, "1"], ["phantomchat-local-tools", "1"], ["control", "true"]];
      const response = createRumor(JSON.stringify(reply), input.secretKey, tags);
      await input.publish(createGiftWrap(createSeal(response, input.secretKey, rumor.pubkey), rumor.pubkey) as unknown as NTNostrEvent);
    }).catch(() => {}).finally(() => {pending--;});
    return queue;
  };
  handler.close = async () => {closed = true; await queue;};
  return handler as VoiceModelsHandler;
}
