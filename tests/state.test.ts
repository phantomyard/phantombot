/**
 * Tests for phantombot-managed runtime state (state.json) and its
 * forensic audit log.
 *
 * Covers: load/save round-trip, the default_persona audit log, and two
 * regressions caught in review of the audit hook —
 *   1. a corrupt state.json must NOT block a repair write (saveState);
 *   2. the audit log must follow PHANTOMBOT_STATE into a tmp dir instead
 *      of leaking into the live data dir during tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { auditPath, loadState, saveState } from "../src/state.ts";

const ENV_KEYS = [
  "PHANTOMBOT_STATE",
  "PHANTOMBOT_STATE_AUDIT",
  "XDG_DATA_HOME",
];
const SAVED_ENV: Record<string, string | undefined> = {};

let workdir: string;
let stateFile: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-state-"));
  for (const k of ENV_KEYS) {
    SAVED_ENV[k] = process.env[k];
    delete process.env[k];
  }
  process.env.XDG_DATA_HOME = join(workdir, "data");
  stateFile = join(workdir, "state.json");
  process.env.PHANTOMBOT_STATE = stateFile;
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
  await rm(workdir, { recursive: true, force: true });
});

async function readAudit(): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(auditPath(), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe("saveState — round-trip", () => {
  test("writes and reads back default_persona", async () => {
    await saveState({ default_persona: "kai" });
    expect(await loadState()).toEqual({ default_persona: "kai" });
  });
});

describe("audit log — default_persona changes", () => {
  test("logs a from→to entry when the persona changes", async () => {
    await saveState({ default_persona: "kai" });
    await saveState({ default_persona: "robbie" });
    const entries = await readAudit();
    expect(entries.length).toBeGreaterThan(0);
    const last = entries[entries.length - 1]!;
    expect(last.from).toBe("kai");
    expect(last.to).toBe("robbie");
    expect(typeof last.pid).toBe("number");
    expect(typeof last.ppid).toBe("number");
    expect(typeof last.ts).toBe("string");
  });

  test("does NOT log a no-op write (unchanged persona)", async () => {
    await saveState({ default_persona: "kai" });
    await saveState({ default_persona: "kai" });
    const entries = await readAudit();
    // Only the first (undefined→kai) change is recorded.
    expect(entries.length).toBe(1);
    expect(entries[0]!.from).toBe(null);
    expect(entries[0]!.to).toBe("kai");
  });
});

describe("regression: corrupt state.json must not block a repair write", () => {
  test("saveState overwrites a malformed state.json instead of throwing", async () => {
    await writeFile(stateFile, "{ this is not valid json", "utf8");
    // This is the repair path: persona/config commands must be able to
    // overwrite a poisoned state.json. The pre-write audit read must be
    // best-effort and never propagate the parse error.
    await saveState({ default_persona: "kai" });
    expect(await loadState()).toEqual({ default_persona: "kai" });
    // The audit entry records the unreadable prior state as a null `from`.
    const entries = await readAudit();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[entries.length - 1]!.to).toBe("kai");
    expect(entries[entries.length - 1]!.from).toBe(null);
  });
});

describe("regression: audit log follows PHANTOMBOT_STATE", () => {
  test("audit log lands next to the state file, not in the live data dir", () => {
    expect(auditPath()).toBe(join(dirname(stateFile), "state-audit.log"));
  });

  test("writing state does not create state-audit.log in XDG_DATA_HOME", async () => {
    await saveState({ default_persona: "kai" });
    const leaked = join(
      process.env.XDG_DATA_HOME!,
      "phantombot",
      "state-audit.log",
    );
    await expect(access(leaked)).rejects.toThrow();
    // But it DOES exist next to the tmp state file.
    await expect(access(auditPath())).resolves.toBeNil();
  });

  test("explicit PHANTOMBOT_STATE_AUDIT still wins", () => {
    const custom = join(workdir, "custom-audit.log");
    process.env.PHANTOMBOT_STATE_AUDIT = custom;
    expect(auditPath()).toBe(custom);
  });
});
