/**
 * `phantombot workspace lock` — what the caller is TOLD, which is a separate
 * question from whether it may proceed.
 *
 * The bug these pin: acquire fails open when the state directory is broken, so
 * the turn's real work is never blocked by a state file that will not write.
 * That policy is right, but the fail-open path returned exactly the shape of a
 * persisted claim, and the CLI printed `locked <path>` and exited 0 with
 * nothing on disk. A turn that believes it holds the lock stops looking for the
 * collision this command exists to surface, so the false assurance is worse
 * than no lock at all.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import workspaceCmd from "../src/cli/workspace.ts";

let dir: string;
let workspace: string;
const prevEnabled = process.env.PHANTOMBOT_WORKSPACE_LOCKS;
const prevDir = process.env.PHANTOMBOT_WORKSPACE_LOCK_DIR;
const prevTurn = process.env.PHANTOMBOT_TURN_ID;
const prevConversation = process.env.PHANTOMBOT_CONVERSATION;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "phantombot-ws-cli-"));
  workspace = await mkdtemp(join(tmpdir(), "phantombot-ws-tree-"));
  process.env.PHANTOMBOT_WORKSPACE_LOCKS = "1";
  process.env.PHANTOMBOT_WORKSPACE_LOCK_DIR = dir;
  process.env.PHANTOMBOT_TURN_ID = "t1";
  process.env.PHANTOMBOT_CONVERSATION = "telegram:1";
});

afterEach(async () => {
  await chmod(dir, 0o700).catch(() => {});
  await rm(dir, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
  for (const [name, prev] of [
    ["PHANTOMBOT_WORKSPACE_LOCKS", prevEnabled],
    ["PHANTOMBOT_WORKSPACE_LOCK_DIR", prevDir],
    ["PHANTOMBOT_TURN_ID", prevTurn],
    ["PHANTOMBOT_CONVERSATION", prevConversation],
  ] as const) {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
  process.exitCode = 0;
});

/** Drive the `lock` subcommand exactly as citty would, capturing both streams. */
async function runLock(path: string): Promise<{
  out: string;
  err: string;
  code: number;
}> {
  const subs = await Promise.resolve(
    typeof workspaceCmd.subCommands === "function"
      ? workspaceCmd.subCommands()
      : workspaceCmd.subCommands,
  );
  const cmd = await Promise.resolve(subs?.lock);
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => {
    out.push(String(s));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => {
    err.push(String(s));
    return true;
  }) as typeof process.stderr.write;
  process.exitCode = 0;
  try {
    await (
      cmd as {
        run: (ctx: { args: Record<string, unknown> }) => unknown;
      }
    ).run({ args: { path, _: [path] } });
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  return {
    out: out.join(""),
    err: err.join(""),
    code: Number(process.exitCode ?? 0),
  };
}

describe("workspace lock reports what actually happened", () => {
  test("a recorded claim says locked, on stdout, exit 0", async () => {
    const result = await runLock(workspace);
    expect(result.out).toContain(`locked ${workspace}`);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    // ...and there is a record to back the claim up.
    expect((await readdir(dir)).some((n) => n.endsWith(".json"))).toBe(true);
  });

  test("an ENOTDIR lock directory does not report a claim", async () => {
    // A regular file where the state directory should be: the shape of a real
    // misconfiguration, and every create under it fails ENOTDIR.
    const blocker = join(dir, "not-a-dir");
    await writeFile(blocker, "");
    process.env.PHANTOMBOT_WORKSPACE_LOCK_DIR = join(blocker, "locks");

    const result = await runLock(workspace);
    expect(result.out).not.toContain("locked");
    expect(result.err).toContain("NOT claimed");
    expect(result.err).toContain("WITHOUT protection");
    // Fail OPEN is still the policy: the turn's work is not blocked.
    expect(result.code).toBe(0);
  });

  test("an unwritable lock directory does not report a claim", async () => {
    if (process.getuid?.() === 0) return; // root ignores the mode bits
    await chmod(dir, 0o500);
    const result = await runLock(workspace);
    expect(result.out).not.toContain("locked");
    expect(result.err).toContain("NOT claimed");
    expect(result.code).toBe(0);
  });

  test("locking switched off is reported as unclaimed, not as a claim", async () => {
    // Same honesty rule for the deliberate case: nothing was written, so
    // nobody can see a claim, and saying `locked` would be just as untrue.
    process.env.PHANTOMBOT_WORKSPACE_LOCKS = "0";
    const result = await runLock(workspace);
    expect(result.out).not.toContain("locked");
    expect(result.err).toContain("NOT claimed");
    expect(result.err).toContain("switched off");
    expect(result.code).toBe(0);
  });

  test("a live holder is still a refusal, not a fail-open", async () => {
    await runLock(workspace);
    process.env.PHANTOMBOT_TURN_ID = "t2";
    const result = await runLock(workspace);
    expect(result.out).not.toContain("locked");
    expect(result.err).toContain("is held by");
    expect(result.code).toBe(1);
  });
});
