import {afterEach, beforeEach, expect, test} from "bun:test";
import {mkdtempSync, rmSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createEngine, type Engine} from "../src/engine/index.ts";
import {loadConfig} from "../src/config.ts";
import {synthesize, transcribe, sttSupport, ttsSupport} from "../src/lib/audio.ts";
let engine: Engine;
let root: string;
let server: ReturnType<typeof Bun.serve>;
let calls: Array<{url: string; key: string | null; data: any}>;
let baseUrl: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "engine-voice-"));
  calls = [];
  server = Bun.serve({port: 0, async fetch(req) {
    const url = new URL(req.url);
    const data = req.method === "POST" ? (url.pathname.endsWith("transcriptions") ? Object.fromEntries(await req.formData()) : await req.json()) : null;
    calls.push({url: url.pathname + url.search, key: req.headers.get("authorization"), data});
    if (req.headers.get("authorization") === "Bearer invalid") return new Response("denied", {status: 401});
    if (url.pathname.endsWith("models")) return Response.json({data: [
      {id: "speech-a", architecture: {output_modalities: ["speech"]}, supported_voices: ["alloy"]},
      {id: "speech-b", architecture: {output_modalities: ["speech"]}, supported_voices: ["echo"]},
      {id: "transcribe-a", architecture: {output_modalities: ["transcription"]}},
      {id: "chat-model", architecture: {output_modalities: ["text"]}},
    ]});
    if (url.pathname.endsWith("speech")) return new Response(new Uint8Array([73, 68, 51, 1]), {headers: {"content-type": "audio/mpeg"}});
    return Response.json({text: "hello voice"});
  }});
  baseUrl = `http://127.0.0.1:${server.port}/v1`;
  engine = await createEngine({root, log: "silent"});
  await engine.personas.create("voice");
});
afterEach(async () => {await engine.close(); server.stop(true); rmSync(root, {recursive: true, force: true});});
const choice = (keyEnv: string, model: string, apiKey = "test-key") => ({enabled: true, provider: "openai-compatible" as const, baseUrl, keyEnv, model, voice: "alloy", apiKey});
test("modality catalogues share the TUI implementation and reject invalid keys", async () => {
  const tts = await engine.voiceModels.check({modality: "tts", provider: "openai-compatible", baseUrl, apiKey: "test-key", model: "speech-a"});
  expect(tts.models.map(m => m.id)).toEqual(["speech-a", "speech-b"]);
  expect(tts.voices).toEqual(["alloy"]);
  const stt = await engine.voiceModels.check({modality: "stt", provider: "openai-compatible", baseUrl, apiKey: "test-key"});
  expect(stt.models.map(m => m.id)).toEqual(["transcribe-a"]);
  const bad = await engine.voiceModels.check({modality: "tts", provider: "openai-compatible", baseUrl, apiKey: "invalid"});
  expect(bad.ok).toBe(false); expect(bad.models).toEqual([]);
});
test("real engine configure, vault, HTTP synthesis/transcription, off/on and override", async () => {
  const persona = engine.persona("voice");
  await persona.configure({voice: {tts: choice("VOICE_TTS_KEY", "speech-a", "tts-key"), stt: choice("VOICE_STT_KEY", "transcribe-a", "stt-key")}});
  const config = () => engine.run(() => loadConfig("voice"));
  expect((await engine.run(async () => synthesize(await config(), "hello"))).ok).toBe(true);
  expect((await engine.run(async () => transcribe(await config(), Buffer.from("audio"), "audio/ogg")))).toEqual({ok: true, text: "hello voice"});
  expect(calls.some(c => c.key === "Bearer tts-key" && c.data?.model === "speech-a")).toBe(true);
  expect(calls.some(c => c.key === "Bearer stt-key" && c.data?.model === "transcribe-a")).toBe(true);
  await persona.configure({voice: {tts: {enabled: false}}});
  expect((await engine.run(async () => ttsSupport(await config()))).ok).toBe(false);
  expect((await engine.run(async () => sttSupport(await config()))).ok).toBe(true);
  await persona.configure({voice: {tts: {...choice("VOICE_TTS_KEY", "speech-b"), apiKey: undefined, voice: "echo"}}});
  await engine.run(async () => synthesize(await config(), "override"));
  expect(calls.at(-1)?.data).toMatchObject({model: "speech-b", voice: "echo"});
  const text = readFileSync(join((await config()).personasDir, "voice", "config.toml"), "utf8");
  expect(text).not.toContain("tts-key"); expect(text).not.toContain("stt-key");
});
test("switching endpoints without a new key refuses before writing", async () => {
  const p = engine.persona("voice");
  await p.configure({voice: {tts: choice("VOICE_TTS_KEY", "speech-a")}});
  await expect(p.configure({voice: {tts: {...choice("VOICE_TTS_KEY", "speech-a"), baseUrl: "https://other.example/v1", apiKey: undefined}}})).rejects.toThrow("needs its API key");
});

test("remote model-only control authenticates, persists, disables/restores and never returns keys", async () => {
  const {createVoiceModelsHandler} = await import("../src/channels/phantomchat/voiceModels.ts");
  const {generateSecretKey, getPublicKey} = await import("nostr-tools/pure");
  const {npubEncode} = await import("../src/lib/nostrIdentity.ts");
  const {unwrapNip17Message} = await import("../src/lib/nostrCrypto.ts");
  await engine.persona("voice").configure({voice: {tts: choice("VOICE_TTS_KEY", "speech-a"), stt: choice("VOICE_STT_KEY", "transcribe-a")}});
  const owner = generateSecretKey(); const remote = generateSecretKey();
  const ownerHex = getPublicKey(owner);
  const config = await engine.run(() => loadConfig("voice"));
  const replies: any[] = [];
  const handler = createVoiceModelsHandler({persona: "voice", config, allowedNpubs: [npubEncode(ownerHex)], secretKey: remote,
    publish: async event => {replies.push(JSON.parse(unwrapNip17Message(event, owner).content));}});
  const request = (method: string, models?: any, pubkey = ownerHex, created_at = Math.floor(Date.now() / 1000)) => engine.run(async () => handler({pubkey, created_at, content: JSON.stringify({type: "phantomchat-voice-models", id: "request-1", method, models})}));
  await request("get", undefined, getPublicKey(generateSecretKey()));
  await request("get", undefined, ownerHex, Math.floor(Date.now() / 1000) - 120);
  expect(replies).toEqual([]);
  expect(calls).toEqual([]);
  await request("get");
  expect(replies[0].ok).toBe(true);
  expect(JSON.stringify(replies)).not.toContain("test-key");
  await request("set", {tts: {enabled: true, provider: "openai-compatible", baseUrl, model: "speech-b"}});
  expect(replies.at(-1).ok).toBe(true);
  expect(config.voice.tts?.model).toBe("speech-b");
  expect(config.voice.tts?.voice).toBe("echo");
  await request("set", {tts: {enabled: false}, stt: {enabled: false}});
  expect(config.voice.tts?.enabled).toBe(false);
  await request("get");
  expect(replies.at(-1).value.tts.available).toBe(true);
  await request("set", {tts: {enabled: true, provider: "openai-compatible", baseUrl, model: "speech-a"}});
  expect(config.voice.tts?.enabled).toBe(true);
  const before = JSON.stringify(config.voice);
  await request("set", {tts: {enabled: true, provider: "openai-compatible", baseUrl: "https://wrong.example/v1", model: "speech-a"}});
  expect(replies.at(-1).ok).toBe(false); expect(JSON.stringify(config.voice)).toBe(before);
  await handler.close();
});
