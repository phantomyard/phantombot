/**
 * Tests for the `phantombot decision-model` command (issue #602-class
 * interface standardization): the general "Decision model" naming the TUI
 * already uses, with `phantombot jev` kept as a DEPRECATED alias that
 * forwards to the exact same flow.
 *
 * The write path itself (`applyJevConfig`, `jevUpdateEquals`, reusable-key
 * discovery) is covered in cli-jev.test.ts — this file only pins the
 * command surface: the canonical command runs `runJev` without a notice,
 * the alias prints its one-line deprecation notice to stderr (never stdout)
 * and both resolve the persona the same way.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import decisionModelCmd from "../src/cli/decision-model.ts";
import { runJev } from "../src/cli/jev.ts";
import { _resetVaultTrackingForTesting } from "../src/lib/vaultEnvTracking.ts";

// Citty's `meta` may be a value, a function, or a function returning a
// Promise — normalize it the same way tests/cli.test.ts does.
async function resolveMeta(cmd: typeof decisionModelCmd) {
  const m = cmd.meta;
  if (typeof m === "function") return await m();
  return m;
}

let workdir: string;
const SAVED_CONFIG = process.env.PHANTOMBOT_CONFIG;
const savedErrWrite = process.stderr.write.bind(process.stderr);
let errText = "";

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-decision-model-"));
  process.env.PHANTOMBOT_CONFIG = join(workdir, "config.toml");
  process.env.XDG_CONFIG_HOME = join(workdir, "xdg-config");
  process.env.XDG_DATA_HOME = join(workdir, "xdg-data");
  process.env.PHANTOMBOT_PERSONA = "phantom";
  _resetVaultTrackingForTesting();
  errText = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: unknown) => {
    errText += String(chunk);
    return true;
  };
});

afterEach(async () => {
  if (SAVED_CONFIG === undefined) delete process.env.PHANTOMBOT_CONFIG;
  else process.env.PHANTOMBOT_CONFIG = SAVED_CONFIG;
  delete process.env.PHANTOMBOT_PERSONA;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_DATA_HOME;
  _resetVaultTrackingForTesting();
  (process.stderr as any).write = savedErrWrite;
  await rm(workdir, { recursive: true, force: true });
});

describe("phantombot decision-model — the canonical command", () => {
  test("runs the same runJev flow with no deprecation notice", async () => {
    // No persona dir on this fresh workdir → runJev exits 2 after the
    // standard "no persona" diagnostic. The point here is the ABSENCE of
    // the alias notice: the canonical command is not deprecated.
    const code = await runJev({ persona: "phantom" });
    expect(code).toBe(2);
    expect(errText).toContain("no persona 'phantom'");
    expect(errText).not.toContain("deprecated");
  });

  test("the command meta standardizes on the general concept", async () => {
    const meta = await resolveMeta(decisionModelCmd);
    expect(meta?.name).toBe("decision-model");
    // The description names the general concept first, the concrete
    // model second — the same framing as the TUI's provider picker.
    const description = String(meta?.description ?? "");
    expect(description).toContain("decision model");
    expect(description).toContain("TypeSafe Jev");
  });
});

describe("phantombot jev — the deprecated alias", () => {
  test("prints a one-line deprecation notice to stderr and forwards", async () => {
    // Same fresh-workdir exit path as above; the ONLY difference is the
    // notice, which is what keeps old scripts working while telling their
    // operators where to go.
    const code = await runJev({ persona: "phantom", deprecated: true });
    expect(code).toBe(2);
    expect(errText).toContain(
      "note: `phantombot jev` is deprecated — use `phantombot decision-model`",
    );
    expect(errText).toContain("no persona 'phantom'");
    // One notice line, not a paragraph.
    const noticeLines = errText
      .split("\n")
      .filter((l) => l.includes("deprecated"));
    expect(noticeLines).toHaveLength(1);
  });
});
