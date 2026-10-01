/**
 * #632 — the whole-suite XDG isolation holds even when the AMBIENT
 * environment has all three XDG roots pointed at a fake "live" install
 * before the preload runs. This is the exact shape of the 2026-08-28
 * robbie incident: an engine-scoped harness shell injects XDG_* into every
 * child, so an agent's `bun test` from inside such a shell used to point
 * the suite at the embedding application's live root (`??=` respected it).
 *
 * The probe suite is spawned in a SUBPROCESS with the fake-live dirs in its
 * environment, runs one file that touches every guarded store, and the
 * parent asserts the fake-live dirs are byte-identical afterwards. The probe
 * lives under a dot-dir so bun's default discovery never runs it as part of
 * the real suite.
 */

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUN = process.execPath; // the same bun binary running this suite

test("a full bun test with ambient 'live' XDG roots leaves them byte-identical", async () => {
  const live = await mkdtemp(join(tmpdir(), "phantombot-fake-live-"));
  const liveData = join(live, "data");
  const liveConfig = join(live, "config");
  const liveState = join(live, "state");
  for (const d of [liveData, liveConfig, liveState]) {
    await Bun.$`mkdir -p ${d}/phantombot`.quiet();
  }
  // Pre-existing "live" content that the incident class would have clobbered.
  const stateBefore = '{"default_persona":"robbie"}\n';
  await writeFile(join(liveData, "phantombot", "state.json"), stateBefore, "utf8");

  const probeDir = join(import.meta.dir, ".probe-632");
  await mkdir(probeDir, { recursive: true });
  const probe = join(probeDir, "writes-live-stores.test.ts");
  await writeFile(
    probe,
    `
// Runs UNDER the preload: the isolation must neutralise the ambient XDG
// roots this process was spawned with. Each guarded store gets written.
import { saveState } from "../../src/state.ts";
import { openTaskStore } from "../../src/lib/tasks.ts";
import { openMemoryStore } from "../../src/memory/store.ts";
import { writeConfigToml } from "../../src/lib/configWriter.ts";
import { expect, test } from "bun:test";

test("the probe writes every store it can reach", async () => {
  await saveState({ default_persona: "x-fixture" });
  const tasks = await openTaskStore(process.env.XDG_DATA_HOME + "/phantombot/tasks.sqlite");
  tasks.add({ persona: "x", description: "p", schedule: "0 * * * *", prompt: "p" });
  tasks.close();
  const mem = await openMemoryStore(process.env.XDG_DATA_HOME + "/phantombot/memory.sqlite");
  await mem.close();
  await writeConfigToml(process.env.XDG_CONFIG_HOME + "/phantombot/config.toml", { default_persona: "x-fixture" });
});
`,
    "utf8",
  );

  try {
    // The critical part: the AMBIENT environment the probe's preload meets
    // has all three roots pointed at the fake-live install, plus a stale
    // PHANTOMBOT_STATE — the engine-scoped-shell scenario.
    const proc = Bun.spawnSync(
      [BUN, "test", probe],
      {
        // cwd = the REPO ROOT, not the probe dir: bun reads bunfig.toml
        // (and its preload) from the invocation cwd, and the contract under
        // test is "a `bun test` run inside this repo", preload included.
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          XDG_DATA_HOME: liveData,
          XDG_CONFIG_HOME: liveConfig,
          XDG_STATE_HOME: liveState,
          PHANTOMBOT_STATE: join(liveData, "phantombot", "state.json"),
          PHANTOMBOT_PERSONA: "",
          CI: "",
        },
      },
    );

    expect(proc.exitCode).toBe(0);
    // bun prints test results on stderr.
    const output = proc.stdout.toString() + proc.stderr.toString();
    // The probe must have actually run its write (not skipped, not errored).
    expect(output).toContain("1 pass");
    expect(output).not.toContain("0 pass");

    // Byte-identical acceptance: nothing new under the fake-live roots, and
    // state.json still carries the pre-existing "live" persona.
    for (const d of [liveData, liveConfig, liveState]) {
      const entries = await readdir(join(d, "phantombot"));
      expect(entries.filter((e) => e !== "state.json")).toEqual([]);
    }
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(liveData, "phantombot", "state.json"), "utf8")).toBe(stateBefore);
  } finally {
    await rm(probeDir, { recursive: true, force: true });
    await rm(live, { recursive: true, force: true });
  }
});
