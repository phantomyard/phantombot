/**
 * Where an interactive turn works, and what a headless `--prompt` does
 * (issue #575).
 *
 * Two halves of the same launch contract:
 *
 *   1. A human who runs `phantombot` in `~/Work/project` means "work here" —
 *      what Omarchy relies on when it launches agents from `~/Work`, and what
 *      the TUI ignored by hard-coding `homedir()`.
 *   2. A `--prompt` with nobody watching is REFUSED, by the real binary, before
 *      it touches disk. This half is spawned as a subprocess on purpose: the
 *      refusal lives in the entrypoint, ahead of the credential bootstrap, and
 *      an in-process test of the parser cannot see whether the bootstrap ran.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, writeFile, chmod } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { launchWorkingDir } from "../src/lib/launchCwd.ts";
import { openChat } from "../src/tui/chatSession.ts";
import { openMemoryStore, type MemoryStore } from "../src/memory/store.ts";
import type { Config } from "../src/config.ts";
import type { Harness, HarnessChunk } from "../src/harnesses/types.ts";

let dir: string;
let store: MemoryStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "phantombot-launch-cwd-"));
  await mkdir(join(dir, "lab"), { recursive: true });
  await writeFile(join(dir, "lab", "SOUL.md"), "You are lab.\n");
  store = await openMemoryStore(":memory:");
});

afterEach(async () => {
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("launchWorkingDir", () => {
  test("is the directory the process was launched from", () => {
    expect(launchWorkingDir(() => dir, () => "/home/nobody")).toBe(dir);
  });

  test("falls back to home when the cwd is gone", () => {
    // `process.cwd()` THROWS when the directory was deleted under the shell.
    expect(
      launchWorkingDir(
        () => {
          throw new Error("ENOENT");
        },
        () => "/home/nobody",
      ),
    ).toBe("/home/nobody");
  });

  test("falls back to home when the cwd is not a listable directory", async () => {
    const file = join(dir, "a-file");
    await writeFile(file, "x");
    expect(launchWorkingDir(() => file, () => "/home/nobody")).toBe(
      "/home/nobody",
    );
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const locked = join(dir, "locked");
      await mkdir(locked);
      await chmod(locked, 0o000);
      expect(launchWorkingDir(() => locked, () => "/home/nobody")).toBe(
        "/home/nobody",
      );
      await chmod(locked, 0o700);
    }
  });
});

/** Records the working directory the orchestrator hands the harness. */
function recordingHarness(seen: Array<string | undefined>): Harness {
  return {
    id: "claude",
    available: async () => true,
    async *invoke(input: { workingDir?: string }): AsyncGenerator<HarnessChunk> {
      seen.push(input.workingDir);
      yield { type: "text", text: "ok" } as HarnessChunk;
    },
  } as unknown as Harness;
}

function config(): Config {
  return {
    personasDir: dir,
    harnesses: { chain: ["claude"], claude: { bin: "claude", model: "" } },
  } as unknown as Config;
}

describe("the chat session's working directory", () => {
  test("a turn runs in the directory the TUI was launched from", async () => {
    const seen: Array<string | undefined> = [];
    const chat = await openChat({
      config: config(),
      persona: "lab",
      memory: store,
      harnesses: [recordingHarness(seen)],
      workingDir: dir,
    });
    for await (const _ of chat.send("hello")) void _;
    await chat.close();
    expect(seen).toEqual([dir]);
  });

  test("callers that do not launch from a directory keep home", async () => {
    // Telegram, PhantomChat and scheduled turns have no launch cwd; they must
    // not start working wherever the daemon happened to be started.
    const seen: Array<string | undefined> = [];
    const chat = await openChat({
      config: config(),
      persona: "lab",
      memory: store,
      harnesses: [recordingHarness(seen)],
    });
    for await (const _ of chat.send("hello")) void _;
    await chat.close();
    expect(seen).toEqual([homedir()]);
  });
});

describe("a headless --prompt, run as the real CLI", () => {
  test("is refused with exit 2, points at ask, and writes nothing", async () => {
    const home = await mkdtemp(join(tmpdir(), "phantombot-headless-home-"));
    const proc = Bun.spawnSync(
      [process.execPath, "src/index.ts", "--prompt", "do something"],
      {
        // No TTY on stdin or stdout: exactly `phantombot --prompt … | cat`,
        // a cron line, or a launcher with no terminal.
        stdin: "ignore",
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          PHANTOMBOT_CONFIG: join(home, "config.toml"),
          PHANTOMBOT_STATE: join(home, "state.json"),
          PHANTOMBOT_PERSONAS_DIR: join(home, "personas"),
        },
      },
    );
    const stderr = new TextDecoder().decode(proc.stderr);
    expect(proc.exitCode).toBe(2);
    expect(stderr).toContain("phantombot ask");
    // Refused AHEAD of the credential bootstrap: an unattended caller must not
    // provision a persona or migrate a vault on its way to being turned away.
    // (`.bun` is bun's own runtime cache, created by running src/index.ts
    // through the interpreter; the compiled binary has no such directory.)
    const written = (await readdir(home)).filter((e) => e !== ".bun");
    expect(written).toEqual([]);
    await rm(home, { recursive: true, force: true });
  }, 30_000);
});
