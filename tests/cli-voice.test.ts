import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybePromptRestart } from "../src/cli/harness.ts";
import { applyVoiceConfig } from "../src/cli/voice.ts";
import { loadEnvFile } from "../src/lib/envFile.ts";
import {
  ensureUnitCurrent,
  generateSystemdUnit,
  type ServiceControl,
  type SystemctlResult,
  type SystemctlRunner,
} from "../src/lib/systemd.ts";

let workdir: string;
let configPath: string;
let envPath: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-voice-"));
  configPath = join(workdir, "config.toml");
  envPath = join(workdir, ".env");
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("applyVoiceConfig — elevenlabs", () => {
  test("writes [voice] + [voice.elevenlabs] to config.toml + key to env", async () => {
    await applyVoiceConfig({
      configPath,
      envPath,
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
    const env = await loadEnvFile(envPath);
    expect(env.PHANTOMBOT_ELEVENLABS_API_KEY).toBe("sk_live_TEST");
  });
});

describe("applyVoiceConfig — openai", () => {
  test("writes [voice.openai] block", async () => {
    await applyVoiceConfig({
      configPath,
      envPath,
      apiKey: "sk-OAITEST",
      voice: {
        provider: "openai",
        openai: { model: "tts-1", voice: "nova", speed: 1.0 },
      },
    });
    const cfg = await readFile(configPath, "utf8");
    expect(cfg).toContain('voice = "nova"');
    const env = await loadEnvFile(envPath);
    expect(env.PHANTOMBOT_OPENAI_API_KEY).toBe("sk-OAITEST");
  });
});

describe("applyVoiceConfig — azure_edge", () => {
  test("writes [voice.azure_edge] block; does NOT write any key (free)", async () => {
    await applyVoiceConfig({
      configPath,
      envPath,
      voice: {
        provider: "azure_edge",
        azure_edge: {
          voice: "en-US-JennyNeural",
          rate: "+0%",
          pitch: "+0Hz",
        },
      },
    });
    const cfg = await readFile(configPath, "utf8");
    expect(cfg).toContain('voice = "en-US-JennyNeural"');
    const env = await loadEnvFile(envPath);
    expect(env.PHANTOMBOT_ELEVENLABS_API_KEY).toBeUndefined();
    expect(env.PHANTOMBOT_OPENAI_API_KEY).toBeUndefined();
  });
});

describe("applyVoiceConfig — none", () => {
  test('flips provider to "none"', async () => {
    await applyVoiceConfig({
      configPath,
      envPath,
      voice: { provider: "none" },
    });
    const cfg = await readFile(configPath, "utf8");
    expect(cfg).toContain('provider = "none"');
  });
});

describe("voice save flow rewrites stale systemd unit before restart", () => {
  test("on-disk unit lacking EnvironmentFile= is rewritten and restart sees the upgraded unit", async () => {
    // Pre-create a stale unit (no EnvironmentFile=). This is the exact
    // shape of an install from before Phase 29 — the bug the PR fixes.
    const unitPath = join(workdir, "phantombot.service");
    const BIN = "/home/kai/.local/bin/phantombot";
    const stale = `[Unit]
Description=Phantombot — personality-first chat agent

[Service]
Type=simple
ExecStart=${BIN} run

[Install]
WantedBy=default.target
`;
    expect(stale).not.toContain("EnvironmentFile=");
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

    // The on-disk unit now has EnvironmentFile= — the actual fix.
    const rewritten = await readFile(unitPath, "utf8");
    expect(rewritten).toContain(
      "EnvironmentFile=-%h/.config/phantombot/.env",
    );
    expect(rewritten).toBe(generateSystemdUnit({ binPath: BIN, args: ["run"] }));

    // daemon-reload was issued as part of the rerender.
    expect(sys.calls).toEqual([["--user", "daemon-reload"]]);

    // The actual ordering inside maybePromptRestart: rerender first, then
    // restart. If a refactor swaps the two lines, this fails — that's
    // what was missing from the previous version of this test.
    expect(callOrder).toEqual(["rerender", "restart"]);
    expect(unitContentAtRestart).toContain(
      "EnvironmentFile=-%h/.config/phantombot/.env",
    );
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
