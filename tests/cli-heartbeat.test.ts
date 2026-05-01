import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHeartbeatCli } from "../src/cli/heartbeat.ts";
import type { Config } from "../src/config.ts";

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
let config: Config;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-hbcli-"));
  await mkdir(join(workdir, "personas", "phantom", "memory"), {
    recursive: true,
  });
  await mkdir(join(workdir, "personas", "phantom", "kb"), {
    recursive: true,
  });
  process.env.XDG_DATA_HOME = workdir;
  config = {
    defaultPersona: "phantom",
    turnTimeoutMs: 600_000,
    personasDir: join(workdir, "personas"),
    memoryDbPath: join(workdir, "memory.sqlite"),
    configPath: join(workdir, "config.toml"),
    harnesses: {
      chain: ["claude"],
      claude: { bin: "claude", model: "opus", fallbackModel: "sonnet" },
      pi: { bin: "pi", maxPayloadBytes: 1_500_000 },
    },
    channels: {},
    embeddings: { provider: "none" },
    voice: { provider: "none" },
  };
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("runHeartbeatCli", () => {
  test("happy path returns 0 and prints summary", async () => {
    await writeFile(
      join(workdir, "personas", "phantom", "memory", `${new Date().toISOString().slice(0, 10)}.md`),
      "[decision] something\n",
    );
    await writeFile(
      join(workdir, "personas", "phantom", "memory", "decisions.md"),
      "# Decisions\n",
    );
    const out = new CaptureStream();
    const code = await runHeartbeatCli({
      config,
      out,
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    expect(out.text).toContain("heartbeat ok:");
    expect(out.text).toContain("promoted 1");
  });

  test("missing persona → exit 2", async () => {
    const err = new CaptureStream();
    const code = await runHeartbeatCli({
      config,
      persona: "doesnotexist",
      out: new CaptureStream(),
      err,
    });
    expect(code).toBe(2);
    expect(err.text).toContain("not found");
  });
});
