/**
 * Tests for the login-level start hook (enable-only linger doctrine,
 * PR #509): a marked, idempotent block in ~/.profile that starts the daemon
 * unit at login. Regression coverage that phantombot only ever touches its
 * OWN marker-delimited lines, never the user's other content, and that the
 * Boot teardown (unit disable) leaves linger alone entirely.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOGIN_HOOK_MARKER,
  probeLoginHook,
  writeLoginHook,
} from "../src/lib/autostartBoot.ts";

let workdir: string;
let home: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-hook-"));
  home = join(workdir, "home");
  await Bun.$`mkdir -p ${home}`.quiet();
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

const hookPath = () => join(home, ".profile");

describe("writeLoginHook", () => {
  test("absent file + present=true → marked block appended", async () => {
    const r = await writeLoginHook(true, home);
    expect(r.status).toBe("ok");
    const body = await readFile(hookPath(), "utf8");
    expect(body).toContain(LOGIN_HOOK_MARKER);
    expect(body).toContain("systemctl --user start phantombot.service");
  });

  test("write is idempotent — no duplicate blocks", async () => {
    await writeLoginHook(true, home);
    await writeLoginHook(true, home);
    await writeLoginHook(true, home);
    const body = await readFile(hookPath(), "utf8");
    expect(body.split(LOGIN_HOOK_MARKER).length - 1).toBe(1);
  });

  test("present=false removes only our block; user content untouched", async () => {
    const userLines = "export EDITOR=vim\n# my stuff\n";
    await writeFile(hookPath(), userLines);
    await writeLoginHook(true, home);
    expect(await probeLoginHook(home)).toBe(true);
    const r = await writeLoginHook(false, home);
    expect(r.status).toBe("ok");
    const body = await readFile(hookPath(), "utf8");
    expect(body).toBe(userLines); // byte-identical to before we touched it
    expect(await probeLoginHook(home)).toBe(false);
  });

  test("remove on a file with no block → ok, no-op", async () => {
    await writeFile(hookPath(), "export PAGER=less\n");
    const r = await writeLoginHook(false, home);
    expect(r.status).toBe("ok");
    expect(await readFile(hookPath(), "utf8")).toBe("export PAGER=less\n");
  });

  test("user lines survive BETWEEN add and remove with their own trailing newline kept", async () => {
    await writeFile(hookPath(), "line1\nline2\n");
    await writeLoginHook(true, home);
    await writeLoginHook(false, home);
    const body = await readFile(hookPath(), "utf8");
    expect(body).toBe("line1\nline2\n");
  });

  test("a foreign line that happens to mention phantombot is never removed", async () => {
    await writeFile(hookPath(), "# phantombot fan club notes\nalias pb=phantombot\n");
    await writeLoginHook(false, home);
    const body = await readFile(hookPath(), "utf8");
    expect(body).toContain("fan club");
    expect(body).toContain("alias pb");
  });
});

describe("probeLoginHook", () => {
  test("missing file → false", async () => {
    expect(await probeLoginHook(home)).toBe(false);
  });

  test("unreadable file → false (fail closed)", async () => {
    await writeFile(hookPath(), "x");
    await Bun.$`chmod 000 ${hookPath()}`.quiet();
    const runningAsRoot = (await import("node:os")).userInfo().username === "root";
    if (!runningAsRoot) {
      expect(await probeLoginHook(home)).toBe(false);
    }
    await Bun.$`chmod 644 ${hookPath()}`.quiet();
  });
});
