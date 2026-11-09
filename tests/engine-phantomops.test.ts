/**
 * PhantomOps platform models (src/engine/phantomops.ts): a PhantomOps persona
 * inherits the server's embeddings, decision and voice models over its own
 * brain token, against a real local gateway stand-in and the real engine,
 * vault and config loader.
 */
import {afterEach, beforeEach, expect, test} from "bun:test";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createEngine, type Engine} from "../src/engine/index.ts";
import {loadConfig} from "../src/config.ts";
import {synthesize} from "../src/lib/audio.ts";

let engine: Engine;
let root: string;
let server: ReturnType<typeof Bun.serve>;
let calls: Array<{path: string; key: string | null; data: any}>;
let baseUrl: string;
/** What the stand-in gateway has configured, per modality. */
let platform: Record<string, any>;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "engine-phantomops-"));
  calls = [];
  platform = {
    embeddings: {id: "openai/text-embedding-3-small"},
    decisions: {id: "typesafe/jev-1.13"},
    speech: {id: "openai/gpt-4o-mini-tts", supported_voices: ["alloy", "nova", "alloy"]},
    transcription: {id: "openai/whisper-1"},
  };
  server = Bun.serve({port: 0, async fetch(req) {
    const url = new URL(req.url);
    const data = req.method === "POST" ? await req.json().catch(() => null) : null;
    const key = req.headers.get("authorization");
    calls.push({path: url.pathname + url.search, key, data});
    if (key === "Bearer pok_revoked") return Response.json({error: {message: "invalid key"}}, {status: 401});
    if (url.pathname.endsWith("/models")) {
      const m = url.searchParams.get("output_modalities") ?? "";
      const row = platform[m];
      return Response.json({object: "list", data: row ? [{...row, architecture: {output_modalities: [m]}}] : []});
    }
    if (url.pathname.endsWith("/audio/speech")) return new Response(new Uint8Array([73, 68, 51, 1]), {headers: {"content-type": "audio/mpeg"}});
    return Response.json({error: "unexpected"}, {status: 404});
  }});
  baseUrl = `http://127.0.0.1:${server.port}/api/v1`;
  engine = await createEngine({root, log: "silent"});
  await engine.personas.create("ops");
  await engine.persona("ops").configure({brain: {chain: ["native"], native: {provider: "phantomops", model: "phantomops/auto", apiKey: "pok_first"}}});
  // The engine never writes base_url (the app has no endpoint field); the
  // CLI wizard can. Point this persona's PhantomOps at the stand-in.
  const path = await tomlPath();
  writeFileSync(path, readFileSync(path, "utf8").replace("[harnesses.pi.routing]\n", `[harnesses.pi.routing]\nbase_url = "${baseUrl}"\n`));
});
afterEach(async () => {await engine.close(); server.stop(true); rmSync(root, {recursive: true, force: true});});

const config = () => engine.run(() => loadConfig("ops"));
async function tomlPath() {
  return join((await engine.run(() => loadConfig("ops"))).personasDir, "ops", "config.toml");
}
const inheritAll = {
  embeddings: {provider: "phantomops", model: "x"},
  decisionModel: {provider: "phantomops", judge: true, router: true},
  voice: {tts: {enabled: true, provider: "phantomops", voice: "nova"}, stt: {enabled: true, provider: "phantomops"}},
} as const;

test("platformModels lists the server's models and voices with the stored token", async () => {
  const models = await engine.persona("ops").platformModels();
  expect(models).toEqual({
    status: "available", detail: "",
    embeddings: "openai/text-embedding-3-small",
    decision: "typesafe/jev-1.13",
    tts: {model: "openai/gpt-4o-mini-tts", voices: ["alloy", "nova"]},
    stt: "openai/whisper-1",
  });
  expect(calls.length).toBe(4);
  expect(calls.every(c => c.key === "Bearer pok_first" && c.path.startsWith("/api/v1/models?output_modalities="))).toBe(true);
  expect(JSON.stringify(models)).not.toContain("pok_");
});

test("platformModels omits what the server has not configured", async () => {
  delete platform.decisions;
  delete platform.speech;
  const models = await engine.persona("ops").platformModels();
  expect(models.status).toBe("available");
  expect(models.decision).toBeUndefined();
  expect(models.tts).toBeUndefined();
  expect(models.embeddings).toBe("openai/text-embedding-3-small");
});

test("platformModels is unavailable for other personas and rejected tokens", async () => {
  await engine.personas.create("plain");
  expect((await engine.persona("plain").platformModels()).status).toBe("unavailable");
  await engine.persona("ops").configure({brain: {native: {provider: "phantomops", model: "phantomops/auto", apiKey: "pok_revoked"}}});
  const r = await engine.persona("ops").platformModels();
  expect(r.status).toBe("unavailable");
  expect(r.detail).toContain("rejected");
});

test("configure inherits every slot over the brain token and endpoint", async () => {
  await engine.persona("ops").configure(inheritAll);
  const c = await config();
  expect(c.embeddings.provider).toBe("openai-compatible");
  expect(c.embeddings.openaiCompatible).toMatchObject({baseUrl, apiKey: "pok_first", dims: 0});
  expect(c.jev).toMatchObject({statedProvider: "phantomops", baseUrl, keyEnv: "PHANTOMBOT_PI_API_KEY", apiKey: "pok_first"});
  expect(c.jev.judge.enabled).toBe(true);
  expect((await engine.run(async () => synthesize(await config(), "hello"))).ok).toBe(true);
  const speech = calls.find(c => c.path === "/api/v1/audio/speech");
  expect(speech?.key).toBe("Bearer pok_first");
  expect(speech?.data?.voice).toBe("nova");
  const text = readFileSync(await tomlPath(), "utf8");
  expect(text).not.toContain("pok_first");
});

test("a new PhantomOps token reaches every inherited slot", async () => {
  await engine.persona("ops").configure(inheritAll);
  await engine.persona("ops").configure({brain: {native: {provider: "phantomops", model: "phantomops/auto", apiKey: "pok_second"}}});
  const c = await config();
  expect(c.embeddings.openaiCompatible?.apiKey).toBe("pok_second");
  expect(c.jev.apiKey).toBe("pok_second");
  await engine.run(async () => synthesize(await config(), "hello"));
  expect(calls.filter(c => c.path === "/api/v1/audio/speech").at(-1)?.key).toBe("Bearer pok_second");
});

test("switching the brain away turns every borrowed slot off", async () => {
  await engine.persona("ops").configure(inheritAll);
  await engine.persona("ops").configure({brain: {native: {provider: "openrouter", model: "openai/gpt-5", apiKey: "sk-or-other"}}});
  const c = await config();
  expect(c.embeddings.provider).toBe("none");
  expect(c.jev.judge.enabled).toBe(false);
  expect(c.jev.router.enabled).toBe(false);
  expect(c.jev.baseUrl === baseUrl).toBe(false);
  expect(c.voice?.tts?.enabled ?? false).toBe(false);
  expect(c.voice?.stt?.enabled ?? false).toBe(false);
  expect(await engine.persona("ops").secrets.has("PHANTOMBOT_OPENAI_COMPATIBLE_API_KEY")).toBe(false);
  // Nothing can reach the PhantomOps endpoint with the new key.
  const before = calls.length;
  await engine.run(async () => synthesize(await config(), "hello")).catch(() => {});
  expect(calls.slice(before).some(c => c.key === "Bearer sk-or-other")).toBe(false);
});

test("phantomops slots refuse a non-PhantomOps brain and a caller key or endpoint", async () => {
  await engine.personas.create("plain");
  await expect(engine.persona("plain").configure({embeddings: {provider: "phantomops", model: "x"}})).rejects.toThrow("needs a PhantomOps brain");
  await expect(engine.persona("plain").configure({decisionModel: {provider: "phantomops"}})).rejects.toThrow("needs a PhantomOps brain");
  await expect(engine.persona("plain").configure({voice: {stt: {enabled: true, provider: "phantomops"}}})).rejects.toThrow("needs a PhantomOps brain");
  const ops = engine.persona("ops");
  await expect(ops.configure({decisionModel: {provider: "phantomops", apiKey: "k"}})).rejects.toThrow("do not pass apiKey");
  await expect(ops.configure({voice: {tts: {enabled: true, provider: "phantomops", voice: "nova", baseUrl: "https://evil.example/v1"}}})).rejects.toThrow("do not pass baseUrl");
  await expect(ops.configure({embeddings: {provider: "phantomops", model: "x", apiKey: "k"}})).rejects.toThrow("do not pass apiKey");
  await expect(ops.configure({voice: {tts: {enabled: true, provider: "phantomops"}}})).rejects.toThrow("TTS voice is required");
});
