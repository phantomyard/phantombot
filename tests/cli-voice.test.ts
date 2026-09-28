import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybePromptRestart } from "../src/cli/harness.ts";
import {
  applyVoiceConfig,
  findStoredVoiceCredential,
  runVoice,
} from "../src/cli/voice.ts";
import type { Config } from "../src/config.ts";
import { personaDir } from "../src/config.ts";
import { openPersonaVault } from "../src/lib/vault.ts";
import {
  ensureUnitCurrent,
  generateSystemdUnit,
  type ServiceControl,
  type SystemctlResult,
  type SystemctlRunner,
} from "../src/lib/systemd.ts";

let workdir: string;
let configPath: string;
let personasDir: string;
let hostConfig: Config;

/** Read one secret back out of a persona's encrypted vault. */
async function readVault(
  persona: string,
  name: string,
): Promise<string | undefined> {
  const vault = await openPersonaVault(personaDir(hostConfig, persona));
  try {
    return vault.get(name);
  } finally {
    vault.close();
  }
}

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-voice-"));
  configPath = join(workdir, "config.toml");
  personasDir = join(workdir, "personas");
  await mkdir(join(personasDir, "phantom"), { recursive: true });
  hostConfig = { defaultPersona: "phantom", personasDir } as unknown as Config;
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("applyVoiceConfig — elevenlabs", () => {
  test("writes [voice] + [voice.elevenlabs] to config.toml + key to env", async () => {
    await applyVoiceConfig({
      configPath,
      config: hostConfig,
      apiKey: "sk_live_TEST",
      voice: {
        provider: "elevenlabs",
        elevenlabs: {
          voiceId: "voice_123",
          modelId: "eleven_turbo_v2_5",
          stability: 1,
          similarityBoost: 0.7,
          style: 0.8,
        },
      },
    });
    const cfg = await readFile(configPath, "utf8");
    expect(cfg).toContain("[voice]");
    expect(cfg).toContain('provider = "elevenlabs"');
    expect(cfg).toContain("[voice.elevenlabs]");
    expect(cfg).toContain('voice_id = "voice_123"');
    // Key lands in the persona's ENCRYPTED vault, never a plaintext file.
    expect(await readVault("phantom", "PHANTOMBOT_ELEVENLABS_API_KEY")).toBe(
      "sk_live_TEST",
    );
    expect(existsSync(join(workdir, ".env"))).toBe(false);
  });
});

describe("applyVoiceConfig — OpenAI-compatible", () => {
  test("writes the endpoint block and removes the legacy OpenAI block", async () => {
    await writeFile(
      configPath,
      '[voice]\nprovider = "openai"\n\n[voice.openai]\nmodel = "tts-1"\n',
    );
    await applyVoiceConfig({
      configPath,
      config: hostConfig,
      apiKey: "sk-OAITEST",
      voice: {
        provider: "openai-compatible",
        openaiCompatible: {
          baseUrl: "https://api.openai.com/v1",
          keyEnv: "PHANTOMBOT_OPENAI_API_KEY",
          sttModel: "whisper-1",
          ttsModel: "tts-1",
          voice: "nova",
          speed: 1,
        },
      },
    });
    const cfg = await readFile(configPath, "utf8");
    expect(cfg).toContain('[voice.openai_compatible]');
    expect(cfg).not.toContain('[voice.openai]');
    expect(cfg).toContain('base_url = "https://api.openai.com/v1"');
    expect(cfg).toContain('voice = "nova"');
    expect(await readVault("phantom", "PHANTOMBOT_OPENAI_API_KEY")).toBe(
      "sk-OAITEST",
    );
  });
});

describe("applyVoiceConfig — azure_edge", () => {
  test("refuses the retired provider with migration guidance", async () => {
    await expect(applyVoiceConfig({
      configPath,
      config: hostConfig,
      voice: {
        provider: "azure_edge",
        azure_edge: {
          voice: "en-US-JennyNeural",
          rate: "+0%",
          pitch: "+0Hz",
        },
      },
    })).rejects.toThrow("was removed");
    expect(existsSync(configPath)).toBe(false);
  });
});

describe("applyVoiceConfig — none", () => {
  test('flips provider to "none"', async () => {
    await applyVoiceConfig({
      configPath,
      config: hostConfig,
      voice: { provider: "none" },
    });
    const cfg = await readFile(configPath, "utf8");
    expect(cfg).toContain('provider = "none"');
  });
});

describe("OpenAI-compatible credential reuse", () => {
  test("finds a matching key only in the current persona's vault", async () => {
    await mkdir(join(personasDir, "lena"), { recursive: true });
    const vault = await openPersonaVault(join(personasDir, "phantom"));
    try {
      vault.set("OPENROUTER_API_KEY", "or-secret");
    } finally {
      vault.close();
    }

    const found = await findStoredVoiceCredential(
      hostConfig,
      "phantom",
      "openai-compatible",
      "https://openrouter.ai/api/v1/",
    );
    expect(found).toEqual({
      name: "OPENROUTER_API_KEY",
      value: "or-secret",
      needsWrite: false,
    });
    expect(
      await findStoredVoiceCredential(
        hostConfig,
        "lena",
        "openai-compatible",
        "https://openrouter.ai/api/v1",
      ),
    ).toBeUndefined();
  });
});

describe("voice save flow rewrites stale systemd unit before restart", () => {
  test("a stale on-disk unit is rewritten to the current template before restart", async () => {
    // Pre-create a stale unit. Since #452 the staleness that matters is the
    // reverse of the original bug: an OLD unit still carries the retired
    // `EnvironmentFile=` lines that sourced plaintext .env files, and the
    // rerender is what strips them.
    const unitPath = join(workdir, "phantombot.service");
    const BIN = "/home/kai/.local/bin/phantombot";
    const stale = `[Unit]
Description=Phantombot — personality-first chat agent

[Service]
Type=simple
ExecStart=${BIN} run
EnvironmentFile=-%h/.config/phantombot/.env
EnvironmentFile=-%h/.env

[Install]
WantedBy=default.target
`;
    expect(stale).toContain("EnvironmentFile=");
    await writeFile(unitPath, stale, "utf8");

    class FakeSystemctl implements SystemctlRunner {
      calls: string[][] = [];
      async run(args: readonly string[]): Promise<SystemctlResult> {
        this.calls.push([...args]);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    }
    const sys = new FakeSystemctl();

    const callOrder: string[] = [];
    let unitContentAtRestart: string | undefined;
    const svc: ServiceControl = {
      isActive: async () => true,
      start: async () => ({ ok: true }),
      stop: async () => ({ ok: true }),
      restart: async () => {
        callOrder.push("restart");
        unitContentAtRestart = await readFile(unitPath, "utf8");
        return { ok: true };
      },
      rerenderUnitIfStale: async () => {
        callOrder.push("rerender");
        return ensureUnitCurrent({ unitPath, binPath: BIN, systemctl: sys });
      },
    };

    // Drive the REAL maybePromptRestart (not just maybeUpgradeUnit) by
    // injecting an auto-confirm — this proves the production code path
    // calls rerender BEFORE restart, instead of asserting on test-local
    // instrumentation. This is the gap #35 was filed to close.
    await maybePromptRestart(svc, async () => true);

    // The on-disk unit no longer sources any plaintext .env — the #452 fix.
    const rewritten = await readFile(unitPath, "utf8");
    expect(rewritten).not.toContain("EnvironmentFile=");
    expect(rewritten).toBe(generateSystemdUnit({ binPath: BIN, args: ["run"] }));

    // daemon-reload was issued as part of the rerender.
    expect(sys.calls).toEqual([["--user", "daemon-reload"]]);

    // The actual ordering inside maybePromptRestart: rerender first, then
    // restart. If a refactor swaps the two lines, this fails — that's
    // what was missing from the previous version of this test.
    expect(callOrder).toEqual(["rerender", "restart"]);
    expect(unitContentAtRestart).not.toContain("EnvironmentFile=");
  });

  test("maybePromptRestart skips restart when confirm returns false", async () => {
    const unitPath = join(workdir, "phantombot.service");
    const callOrder: string[] = [];
    const fakeSystemctl: SystemctlRunner = {
      async run(_args: readonly string[]): Promise<SystemctlResult> {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const svc: ServiceControl = {
      isActive: async () => true,
      start: async () => ({ ok: true }),
      stop: async () => ({ ok: true }),
      restart: async () => {
        callOrder.push("restart");
        return { ok: true };
      },
      rerenderUnitIfStale: async () => {
        callOrder.push("rerender");
        return ensureUnitCurrent({
          unitPath,
          binPath: "/bin/phantombot",
          systemctl: fakeSystemctl,
        });
      },
    };
    await maybePromptRestart(svc, async () => false);
    // Rerender ran (always does) but restart was declined.
    expect(callOrder).toEqual(["rerender"]);
  });
});

describe("runVoice — unknown persona", () => {
  test("refuses a --persona that does not exist, before writing anything", async () => {
    // A typo used to be silently "successful": loadConfig reads a missing
    // persona file as an empty layer, and the writes CREATE
    // `<personas-root>/typo/config.toml` (plus its directory), save the
    // provider credential and offer a restart — for a persona that does not
    // exist and never runs. `task --persona` already refuses this class of
    // silent loss; so does voice now (phantombot#439).
    const personasDir = join(workdir, "personas");
    await mkdir(join(personasDir, "lena"), { recursive: true });
    const errors: string[] = [];
    let restarted = false;

    const code = await runVoice({
      persona: "lenaa",
      config: {
        defaultPersona: "lena",
        personaLayer: "lenaa",
        harnessIdleTimeoutMs: 1000,
        harnessHardTimeoutMs: 1000,
        harnessStartupTimeoutMs: 1000,
        personasDir,
        memoryDbPath: join(workdir, "memory.sqlite"),
        configPath,
        harnesses: {
          chain: ["claude"],
          claude: { bin: "claude", model: "opus", fallbackModel: "sonnet" },
          pi: { bin: "pi", maxPayloadBytes: 1 },
        },
        channels: {},
        embeddings: { provider: "none" },
        voice: { provider: "none" },
      } as unknown as Config,
      err: { write: (t: string) => (errors.push(String(t)), true) },
      serviceControl: {
        restart: async () => {
          restarted = true;
          return { ok: true, stdout: "", stderr: "" };
        },
      } as unknown as ServiceControl,
    });

    expect(code).toBe(2);
    expect(errors.join("")).toContain("lenaa");
    expect(restarted).toBe(false);
    // No directory, no config file, nothing to clean up.
    expect(existsSync(join(personasDir, "lenaa"))).toBe(false);
  });
});
