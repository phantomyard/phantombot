/**
 * Production-path env regression for `phantombot doctor` (PR #474 review):
 * with no injected config and PHANTOMBOT_PERSONA=leo, doctor must diagnose
 * with LEO's layer — its embeddings provider — while the default persona's
 * layer says something else. Both layers differ here so the embeddings line
 * in the report is unambiguous.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../src/cli/doctor.ts";

class CaptureStream {
  chunks: string[] = [];
  write(s: string | Uint8Array): boolean {
    this.chunks.push(typeof s === "string" ? s : new TextDecoder().decode(s));
    return true;
  }
  get text(): string {
    return this.chunks.join("");
  }
}

let workdir: string;

/** Two personas with DIFFERENT embeddings providers on disk. */
async function writePersonaConfigs(): Promise<void> {
  await mkdir(join(workdir, "personas", "phantom"), { recursive: true });
  await mkdir(join(workdir, "personas", "leo"), { recursive: true });
  // Default persona: gemini WITHOUT a key → semantic search off.
  await writeFile(
    join(workdir, "personas", "phantom", "config.toml"),
    `[embeddings]\nprovider = "gemini"\n`,
    "utf8",
  );
  // Target persona: openai-compatible with base_url + model → semantic ON.
  await writeFile(
    join(workdir, "personas", "leo", "config.toml"),
    `[embeddings]\nprovider = "openai-compatible"\n\n[embeddings.openai_compatible]\nbase_url = "http://127.0.0.1:8082/v1"\nmodel = "test-model"\n`,
    "utf8",
  );
  await writeFile(join(workdir, "config.toml"), "", "utf8");
}

function installEnv(): void {
  process.env.PHANTOMBOT_CONFIG = join(workdir, "config.toml");
  process.env.PHANTOMBOT_PERSONAS_DIR = join(workdir, "personas");
  process.env.PHANTOMBOT_STATE = join(workdir, "state.json");
}

function clearEnv(): void {
  delete process.env.PHANTOMBOT_CONFIG;
  delete process.env.PHANTOMBOT_PERSONAS_DIR;
  delete process.env.PHANTOMBOT_STATE;
  delete process.env.PHANTOMBOT_PERSONA;
}

const disabledChecks = {
  checkSystemd: false,
  checkTimers: false,
  checkHarnesses: false,
  checkPiExtension: false,
  checkEditorConnectors: false,
} as const;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-doctor-env-"));
  await writePersonaConfigs();
  installEnv();
});

afterEach(async () => {
  clearEnv();
  await rm(workdir, { recursive: true, force: true });
});

describe("runDoctor — PHANTOMBOT_PERSONA env (production path)", () => {
  test("env persona's layer drives the diagnostics (leo → semantic ON, openai-compatible)", async () => {
    process.env.PHANTOMBOT_PERSONA = "leo";
    const out = new CaptureStream();

    const code = await runDoctor({ out, ...disabledChecks });

    expect(out.text).toContain("persona 'leo'");
    expect(out.text).toContain(
      "provider 'openai-compatible'",
    );
    expect(out.text).not.toContain("provider 'gemini'");
    expect(code).toBe(0);
  });

  test("without env, the default persona's layer is diagnosed (phantom → gemini, semantic off)", async () => {
    const out = new CaptureStream();

    const code = await runDoctor({ out, ...disabledChecks });

    expect(out.text).toContain("persona 'phantom'");
    expect(out.text).toContain("semantic (vector) search off");
    expect(code).toBe(0);
  });
});
