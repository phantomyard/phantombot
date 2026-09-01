/**
 * Pins what the preload (tests/testEnvIsolation.ts) guarantees to every other
 * test file. Both variables are silent, action-at-a-distance failures when
 * they leak in: PHANTOMBOT_PERSONA redirects persona-aware code at another
 * persona's data (#473), and $CI flips ink to its non-interactive renderer, so
 * the TUI rendering tests measure a renderer no user ever sees — green on a
 * laptop, red on GitHub Actions.
 */

import { expect, test } from "bun:test";
import isInCi from "is-in-ci";

test("the preload strips ambient PHANTOMBOT_PERSONA", () => {
  expect(process.env.PHANTOMBOT_PERSONA).toBeUndefined();
});

test("the preload strips $CI, so ink uses its interactive renderer", () => {
  expect(process.env.CI).toBeUndefined();
  expect(process.env.CONTINUOUS_INTEGRATION).toBeUndefined();
  // The consumer that matters: ink reads this at module load.
  expect(isInCi).toBe(false);
});

/**
 * State isolation — the 2026-09-01 incident. A `bun test` run on a live host
 * rewrote that host's real state.json twice (persona-new adopted a default,
 * then the ACP server's heal set it to a FIXTURE persona name), breaking the
 * host's CLI default and arming a heartbeat timer for a persona that does not
 * exist. Nothing failed; the run was green.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

test("the preload redirects state.json away from the real host", () => {
  const root = process.env.PHANTOMBOT_TEST_ISOLATION_ROOT;
  expect(root).toBeString();
  expect(resolve(process.env.PHANTOMBOT_STATE!).startsWith(resolve(root!) + sep)).toBe(true);
  expect(resolve(process.env.XDG_DATA_HOME!).startsWith(resolve(root!) + sep)).toBe(true);
});

test("saveState REFUSES to write outside the isolation root", async () => {
  // The remaining hole the preload cannot close: a test that clears
  // PHANTOMBOT_STATE outright (or restores a saved-undefined value) falls back
  // to $XDG_DATA_HOME/phantombot/state.json. The guard turns that from a
  // silent host mutation into a loud failure — this is the whole point of the
  // fix, so it is asserted rather than assumed.
  const { saveState } = await import("../src/state.ts");
  const saved = process.env.PHANTOMBOT_STATE;
  const savedXdg = process.env.XDG_DATA_HOME;
  process.env.PHANTOMBOT_STATE = join(resolve(sep), "not-a-temp-dir", "state.json");
  try {
    await expect(saveState({ default_persona: "Phantom" })).rejects.toThrow(
      /refusing to write state\.json outside test isolation/,
    );
  } finally {
    process.env.PHANTOMBOT_STATE = saved;
    process.env.XDG_DATA_HOME = savedXdg;
  }
});

test("a test's own temp state path is still allowed", async () => {
  // 23 suites pin their own mkdtemp path; the guard must not break them.
  const { saveState } = await import("../src/state.ts");
  const dir = await mkdtemp(join(tmpdir(), "phantombot-state-guard-"));
  const saved = process.env.PHANTOMBOT_STATE;
  process.env.PHANTOMBOT_STATE = join(dir, "state.json");
  try {
    const written = await saveState({ default_persona: "lena" });
    expect(JSON.parse(await readFile(written, "utf8")).default_persona).toBe("lena");
  } finally {
    process.env.PHANTOMBOT_STATE = saved;
    await rm(dir, { recursive: true, force: true });
  }
});
