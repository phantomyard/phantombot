/**
 * Tests for the robot reply voice (`[voice] tts = "robot"`): espeak-ng →
 * ffmpeg → OGG-Opus, driven through an injected runner — no binaries, no
 * network.
 */

import { describe, expect, test } from "bun:test";
import {
  resolveRobotBinary,
  type RobotRunner,
  robotEspeakVoice,
  sttSupport,
  synthesize,
  ttsSupport,
} from "../src/lib/audio.ts";
import type { Config } from "../src/config.ts";

function robotConfig(
  voice: "female" | "male" = "female",
  provider: "openai-compatible" | "elevenlabs" | "none" = "openai-compatible",
): Config {
  return {
    defaultPersona: "x",
    personasDir: "/tmp/phantombot-robot-test-none",
    voice: {
      provider,
      tts: "robot",
      robot: { voice },
      openaiCompatible: provider === "openai-compatible"
        ? {
          baseUrl: "https://api.openai.com/v1",
          keyEnv: "PHANTOMBOT_TEST_ROBOT_KEY",
          sttModel: "whisper-1",
          ttsModel: "gpt-4o-mini-tts",
          voice: "nova",
          speed: 1,
        }
        : undefined,
    },
  } as unknown as Config;
}

/** Records every command and answers from a script keyed by binary. */
function scriptedRunner(
  answers: Partial<Record<string, (cmd: string[]) => { exitCode: number; out?: string; err?: string }>>,
) {
  const calls: string[][] = [];
  const run: RobotRunner = async (cmd) => {
    calls.push(cmd);
    const a = answers[cmd[0]!]?.(cmd) ?? { exitCode: 0, out: `${cmd[0]}-out` };
    return {
      exitCode: a.exitCode,
      stdout: new TextEncoder().encode(a.out ?? ""),
      stderr: a.err ?? "",
    };
  };
  return { run, calls };
}

const noFetch = (async () => {
  throw new Error("robot voice must not touch the network");
}) as unknown as typeof fetch;

describe("robot voice — synthesize", () => {
  test("speaks with the female preset and returns OGG for a voice note", async () => {
    const { run, calls } = scriptedRunner({});
    const r = await synthesize(robotConfig("female"), "The curtains are now closed.", noFetch, run);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.audio.mime).toBe("audio/ogg");
    expect(calls[0]).toEqual([
      "espeak-ng", "-v", "en+f3", "-s", "145", "-p", "55", "--stdout", "--stdin",
    ]);
    expect(calls[1]![0]).toBe("ffmpeg");
    expect(calls[1]).toContain("libopus");
  });

  test("male preset uses its own variant, speed and pitch", async () => {
    const { run, calls } = scriptedRunner({});
    await synthesize(robotConfig("male"), "Closing curtains now, see you tomorrow.", noFetch, run);
    expect(calls[0]!.slice(0, 7)).toEqual(["espeak-ng", "-v", "en+m3", "-s", "130", "-p", "30"]);
  });

  test("speaks the reply's own language", () => {
    expect(robotEspeakVoice("De gordijnen zijn nu dicht. Fijne avond nog, tot morgen!", { voice: "female" }))
      .toBe("nl+f3");
    expect(robotEspeakVoice("ok", { voice: "male" })).toBe("en+m3");
  });

  test("falls back to English when espeak-ng has no voice for the language", async () => {
    const { run, calls } = scriptedRunner({
      "espeak-ng": (cmd) => (cmd[2] === "en+f3" ? { exitCode: 0, out: "wav" } : { exitCode: 1, err: "voice not found" }),
    });
    const r = await synthesize(
      robotConfig("female"),
      "De gordijnen zijn nu dicht. Fijne avond nog, tot morgen!",
      noFetch,
      run,
    );
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c[2])).toEqual(["nl+f3", "en+f3", "-loglevel"]);
  });

  test("an espeak-ng failure is an error, never empty audio", async () => {
    const { run } = scriptedRunner({ "espeak-ng": () => ({ exitCode: 1, err: "boom" }) });
    const r = await synthesize(robotConfig(), "hello there", noFetch, run);
    expect(r).toEqual({ ok: false, error: "espeak-ng failed: boom" });
  });

  test("an ffmpeg failure is an error", async () => {
    const { run } = scriptedRunner({ ffmpeg: () => ({ exitCode: 1, err: "no libopus" }) });
    const r = await synthesize(robotConfig(), "hello there", noFetch, run);
    expect(r).toEqual({ ok: false, error: "ffmpeg failed: no libopus" });
  });

  test("provider none keeps voice off even with the robot selected", async () => {
    const { run, calls } = scriptedRunner({});
    const r = await synthesize(robotConfig("female", "none"), "hello", noFetch, run);
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("robot voice — support diagnostics", () => {
  const all = (b: string) => `/usr/bin/${b}`;

  test("ready when espeak-ng and ffmpeg are on PATH, with no key", async () => {
    expect(await ttsSupport(robotConfig(), all)).toEqual({ ok: true });
  });

  test("names the missing binary", async () => {
    expect(await ttsSupport(robotConfig(), (b) => (b === "espeak-ng" ? null : all(b)))).toEqual({
      ok: false,
      reason: "robot_missing",
      provider: "openai-compatible",
      binary: "espeak-ng",
    });
  });

  test("provider none is reported as off, not as a robot problem", async () => {
    expect((await ttsSupport(robotConfig("female", "none"), all)).ok).toBe(false);
  });

  test("hearing still needs the provider's key — the robot never transcribes", async () => {
    delete process.env.PHANTOMBOT_TEST_ROBOT_KEY;
    const s = await sttSupport(robotConfig());
    expect(s).toMatchObject({ ok: false, reason: "key_missing" });
  });
});

describe("robot voice — finding the binaries", () => {
  const none = () => null;
  const programFiles = { ProgramFiles: "C:\\Program Files" };
  const installed = "C:\\Program Files\\eSpeak NG\\espeak-ng.exe";

  test("PATH wins on every platform", () => {
    expect(resolveRobotBinary("espeak-ng", () => "/usr/bin/espeak-ng", "win32", programFiles, () => true))
      .toBe("/usr/bin/espeak-ng");
  });

  test("Windows falls back to the eSpeak NG install folder", () => {
    expect(resolveRobotBinary("espeak-ng", none, "win32", programFiles, (p) => p === installed))
      .toBe(installed);
  });

  test("no fallback when the install folder is empty, or off Windows", () => {
    expect(resolveRobotBinary("espeak-ng", none, "win32", programFiles, () => false)).toBeNull();
    expect(resolveRobotBinary("espeak-ng", none, "linux", programFiles, () => true)).toBeNull();
  });

  test("ffmpeg is never guessed — it must be on PATH", () => {
    expect(resolveRobotBinary("ffmpeg", none, "win32", programFiles, () => true)).toBeNull();
  });
});
