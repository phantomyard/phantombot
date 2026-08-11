import { describe, expect, test } from "bun:test";
import {
  gatherStatusProbes,
  type StatusProbeDeps,
} from "../src/channels/statusProbes.ts";
import type { Config } from "../src/config.ts";

// The probe module only reads config.channels, config.embeddings and
// config.voice. Build just those surfaces and cast — a full Config literal
// would be noise here.
function cfg(partial: {
  telegram?: { token: string };
  telegramPersonas?: Record<string, { token: string }>;
  embeddings?: Config["embeddings"];
  voice?: Config["voice"];
}): Config {
  return {
    channels: {
      telegram: partial.telegram,
      telegramPersonas: partial.telegramPersonas,
    },
    embeddings: partial.embeddings ?? { provider: "none" },
    voice: partial.voice ?? { provider: "none" },
  } as unknown as Config;
}

// Deps that make every probe a no-op unless a test overrides one. Keeps each
// test focused on one subsystem without real network calls.
function stubDeps(over: Partial<StatusProbeDeps> = {}): StatusProbeDeps {
  return {
    telegramGetMe: async () => ({ ok: false, error: "stub" }),
    validateElevenLabsKey: async () => ({ ok: true, voiceCount: 3 }),
    validateOpenAIKey: async () => ({ ok: true, modelCount: 5 }),
    geminiEmbed: async () => ({
      ok: true,
      values: new Float32Array([0.1]),
      dims: 1,
    }),
    reconcileEditorConnectors: () => [],
    isPhantombotBinary: () => false,
    env: {},
    ...over,
  };
}

describe("gatherStatusProbes — telegram", () => {
  test("returns @handle OK on a valid token", async () => {
    const r = await gatherStatusProbes(
      cfg({ telegram: { token: "T" } }),
      "phantom",
      stubDeps({
        telegramGetMe: async () => ({
          ok: true,
          username: "robbie_bot",
          id: 1,
        }),
      }),
    );
    expect(r.telegram).toBe("@robbie_bot OK");
  });

  test("surfaces the error when getMe fails", async () => {
    const r = await gatherStatusProbes(
      cfg({ telegram: { token: "T" } }),
      "phantom",
      stubDeps({
        telegramGetMe: async () => ({ ok: false, error: "401 Unauthorized" }),
      }),
    );
    expect(r.telegram).toBe("ERR (401 Unauthorized)");
  });

  test("prefers the persona-bound token over the default", async () => {
    let seen = "";
    await gatherStatusProbes(
      cfg({
        telegram: { token: "DEFAULT" },
        telegramPersonas: { kai: { token: "KAI" } },
      }),
      "kai",
      stubDeps({
        telegramGetMe: async (token) => {
          seen = token;
          return { ok: true, username: "kai_bot", id: 2 };
        },
      }),
    );
    expect(seen).toBe("KAI");
  });

  test("omitted when no token is configured", async () => {
    const r = await gatherStatusProbes(cfg({}), "phantom", stubDeps());
    expect(r.telegram).toBeUndefined();
  });
});

describe("gatherStatusProbes — memory", () => {
  test("reports OKF for the no-embeddings mode", async () => {
    const r = await gatherStatusProbes(
      cfg({ embeddings: { provider: "none" } }),
      "phantom",
      stubDeps(),
    );
    expect(r.memory).toContain("okf active");
  });

  test("probes gemini live and reports OK", async () => {
    const r = await gatherStatusProbes(
      cfg({
        embeddings: {
          provider: "gemini",
          gemini: { apiKey: "K", model: "m", dims: 1 },
        },
      }),
      "phantom",
      stubDeps(),
    );
    expect(r.memory).toBe("gemini embeddings OK");
  });

  test("reports gemini error (e.g. 429) when the probe fails", async () => {
    const r = await gatherStatusProbes(
      cfg({
        embeddings: {
          provider: "gemini",
          gemini: { apiKey: "K", model: "m", dims: 1 },
        },
      }),
      "phantom",
      stubDeps({
        geminiEmbed: async () => ({ ok: false, error: "HTTP 429" }),
      }),
    );
    expect(r.memory).toBe("gemini embeddings ERR (HTTP 429)");
  });

  test("flags a missing gemini key without a network call", async () => {
    let called = false;
    const r = await gatherStatusProbes(
      cfg({
        embeddings: {
          provider: "gemini",
          gemini: { apiKey: "", model: "m", dims: 1 },
        },
      }),
      "phantom",
      stubDeps({
        geminiEmbed: async () => {
          called = true;
          return { ok: true, values: new Float32Array([0]), dims: 1 };
        },
      }),
    );
    expect(r.memory).toBe("gemini embeddings — no key");
    expect(called).toBe(false);
  });
});

describe("gatherStatusProbes — voice", () => {
  test("none when voice disabled", async () => {
    const r = await gatherStatusProbes(
      cfg({ voice: { provider: "none" } }),
      "phantom",
      stubDeps(),
    );
    expect(r.voice).toBe("none");
  });

  test("elevenlabs with a valid key reports voice + OK", async () => {
    const r = await gatherStatusProbes(
      cfg({
        voice: {
          provider: "elevenlabs",
          elevenlabs: {
            voiceId: "vX",
            modelId: "m",
            stability: 1,
            similarityBoost: 0.7,
            style: 0.8,
          },
        } as unknown as Config["voice"],
      }),
      "phantom",
      stubDeps({ env: { PHANTOMBOT_ELEVENLABS_API_KEY: "K" } }),
    );
    expect(r.voice).toBe("elevenlabs vX OK");
  });

  test("elevenlabs surfaces a validation error", async () => {
    const r = await gatherStatusProbes(
      cfg({
        voice: {
          provider: "elevenlabs",
          elevenlabs: {
            voiceId: "vX",
            modelId: "m",
            stability: 1,
            similarityBoost: 0.7,
            style: 0.8,
          },
        } as unknown as Config["voice"],
      }),
      "phantom",
      stubDeps({
        env: { PHANTOMBOT_ELEVENLABS_API_KEY: "K" },
        validateElevenLabsKey: async () => ({
          ok: false,
          error: "401 Unauthorized — wrong key",
        }),
      }),
    );
    expect(r.voice).toContain("elevenlabs vX ERR");
  });

  test("flags a missing voice key without a network call", async () => {
    const r = await gatherStatusProbes(
      cfg({
        voice: {
          provider: "openai",
          openai: { model: "tts-1", voice: "nova", speed: 1 },
        } as unknown as Config["voice"],
      }),
      "phantom",
      stubDeps({ env: {} }),
    );
    expect(r.voice).toBe("openai nova — no key");
  });

  test("azure_edge needs no key", async () => {
    const r = await gatherStatusProbes(
      cfg({
        voice: {
          provider: "azure_edge",
          azure_edge: { voice: "en-US-JennyNeural", rate: "+0%", pitch: "+0Hz" },
        } as unknown as Config["voice"],
      }),
      "phantom",
      stubDeps(),
    );
    expect(r.voice).toContain("azure_edge en-US-JennyNeural");
  });
});

describe("gatherStatusProbes — acp", () => {
  test("omitted when not running as the phantombot binary", async () => {
    const r = await gatherStatusProbes(cfg({}), "phantom", stubDeps());
    expect(r.acp).toBeUndefined();
  });

  test("summarizes detected editors, skipping not-detected", async () => {
    const r = await gatherStatusProbes(
      cfg({}),
      "phantom",
      stubDeps({
        isPhantombotBinary: () => true,
        reconcileEditorConnectors: () =>
          [
            { editor: "zed", action: "current", settingsPath: "/z" },
            { editor: "vscode", action: "stale", settingsPath: "/v" },
            { editor: "ghost", action: "not-detected", settingsPath: "/g" },
          ] as never,
      }),
    );
    expect(r.acp).toBe("zed ✓, vscode ⚠ stale");
  });

  test("reports no editors when none detected", async () => {
    const r = await gatherStatusProbes(
      cfg({}),
      "phantom",
      stubDeps({
        isPhantombotBinary: () => true,
        reconcileEditorConnectors: () =>
          [
            { editor: "zed", action: "not-detected", settingsPath: "/z" },
          ] as never,
      }),
    );
    expect(r.acp).toBe("no editors detected");
  });
});

describe("gatherStatusProbes — resilience", () => {
  test("a throwing probe is swallowed and yields undefined", async () => {
    const r = await gatherStatusProbes(
      cfg({ telegram: { token: "T" } }),
      "phantom",
      stubDeps({
        telegramGetMe: async () => {
          throw new Error("boom");
        },
      }),
    );
    expect(r.telegram).toBeUndefined();
  });

  test("a probe that never resolves is capped by the shared deadline", async () => {
    // A provider that hangs forever must not hang /status. With a tiny
    // deadline the probe yields undefined and the others still report.
    const started = Date.now();
    const r = await gatherStatusProbes(
      cfg({
        telegram: { token: "T" },
        embeddings: {
          provider: "gemini",
          gemini: { apiKey: "k", model: "m", dims: 1 },
        } as unknown as Config["embeddings"],
      }),
      "phantom",
      stubDeps({
        deadlineMs: 20,
        // Hangs well past the deadline; never settles on its own.
        geminiEmbed: () => new Promise(() => {}) as never,
        telegramGetMe: async () => ({
          ok: true,
          username: "robbie_bot",
          id: 1,
        }),
      }),
    );
    expect(r.memory).toBeUndefined();
    // The healthy probe still comes back...
    expect(r.telegram).toBe("@robbie_bot OK");
    // ...and the whole call returned promptly rather than hanging.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("a probe that resolves before the deadline still reports normally", async () => {
    const r = await gatherStatusProbes(
      cfg({
        embeddings: {
          provider: "gemini",
          gemini: { apiKey: "k", model: "m", dims: 1 },
        } as unknown as Config["embeddings"],
      }),
      "phantom",
      stubDeps({
        deadlineMs: 500,
        geminiEmbed: async () => ({
          ok: true,
          values: new Float32Array([0.1]),
          dims: 1,
        }),
      }),
    );
    expect(r.memory).toBe("gemini embeddings OK");
  });
});
