/**
 * `isPhantombotBinary` — the gate that decides whether a phantombot process is
 * allowed to touch the user's real filesystem (pi extension, editor
 * connectors, systemd units, scheduled tasks).
 *
 * The bug this replaces was a silent, Windows-only failure-open: six call sites
 * compared `basename(process.execPath) === "phantombot"`, which never holds on
 * Windows because `execPath` ends in `.exe`. So the entire self-heal path never
 * ran there, and left no trace in the logs. The negative cases below are the
 * counterexamples that make the intent explicit — they matter more than the
 * positive ones, because failing OPEN (returning false) is the failure mode
 * that stays invisible, and failing CLOSED (returning true for `bun`) is the
 * one that would write the dev box's config during `bun test`.
 */

import { describe, expect, test } from "bun:test";

import { isPhantombotBinary } from "../src/lib/binaryIdentity.ts";

describe("isPhantombotBinary", () => {
  test("accepts the installed POSIX binary", () => {
    expect(isPhantombotBinary("/usr/local/bin/phantombot")).toBe(true);
    expect(isPhantombotBinary("phantombot")).toBe(true);
  });

  test("accepts the installed Windows binary — the regression this fixes", () => {
    expect(
      isPhantombotBinary(
        "C:\\Users\\aghodgespwa\\AppData\\Local\\Programs\\phantombot\\phantombot.exe",
      ),
    ).toBe(true);
  });

  test("is case-insensitive, because Windows filesystems are", () => {
    expect(isPhantombotBinary("C:\\bin\\Phantombot.EXE")).toBe(true);
    expect(isPhantombotBinary("/usr/bin/PhantomBot")).toBe(true);
  });

  test("rejects generic runtimes — dev and `bun test` must stay inert", () => {
    expect(isPhantombotBinary("/home/andrew/.bun/bin/bun")).toBe(false);
    expect(isPhantombotBinary("/usr/bin/node")).toBe(false);
    expect(isPhantombotBinary("C:\\Program Files\\nodejs\\node.exe")).toBe(false);
    expect(isPhantombotBinary("C:\\bun\\bun.exe")).toBe(false);
  });

  test("rejects the self-update leftover — `.old` must not rewrite config", () => {
    // A `startsWith("phantombot")` gate (the other spelling that existed in the
    // tree) wrongly accepts this. The `.old` binary is the PREVIOUS version,
    // moved aside because a running .exe can't be deleted; if it ever executes
    // it must not re-register editors or rewrite scheduled tasks.
    expect(isPhantombotBinary("C:\\pb\\phantombot.exe.old")).toBe(false);
  });

  test("rejects the release download artifact", () => {
    // Also wrongly accepted by `startsWith("phantombot")`. This is the file the
    // updater fetches; it is not an installed binary.
    expect(isPhantombotBinary("C:\\tmp\\phantombot-v1.1.194-windows-x64.exe")).toBe(
      false,
    );
    expect(isPhantombotBinary("/tmp/phantombot-v1.1.194-linux-x64")).toBe(false);
  });

  test("rejects lookalikes that merely contain the name", () => {
    expect(isPhantombotBinary("/usr/bin/phantombot-shim")).toBe(false);
    expect(isPhantombotBinary("/usr/bin/notphantombot")).toBe(false);
    expect(isPhantombotBinary("/opt/phantombot/bin/runner")).toBe(false);
  });

  test("defaults to the live process — inert under `bun test`", () => {
    // The suite itself runs under `bun`, so the production default MUST be
    // false here. If this ever flips, `bun test` starts writing ~/.config/zed.
    expect(isPhantombotBinary()).toBe(false);
  });
});
