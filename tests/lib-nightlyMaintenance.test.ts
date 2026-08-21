/**
 * #417 — the nightly's housekeeping on the memory database: retire decayed
 * beliefs, then take a verified restore point.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runMemoryMaintenance } from "../src/lib/nightlyMaintenance.ts";
import { listRestorePoints } from "../src/memory/dbBackup.ts";
import { openDrawerStore } from "../src/memory/drawerSync.ts";

const PERSONA = "robbie";

async function workdir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "nightly-maint-"));
}

function sink() {
  const chunks: string[] = [];
  return { write: (t: string) => void chunks.push(t), text: () => chunks.join("") };
}

describe("runMemoryMaintenance", () => {
  test("retires decayed beliefs and takes a snapshot", async () => {
    const dir = await workdir();
    const dbPath = join(dir, "memory.sqlite");
    const { store, close } = await openDrawerStore(dbPath);
    // A lesson last reaffirmed years ago is under the dormancy floor; a
    // commitment of the same age is NOT, because commitments do not decay.
    const old = new Date("2020-01-01T00:00:00Z");
    store.file({ persona: PERSONA, kind: "lessons", content: "ancient", assertedAt: old });
    store.file({ persona: PERSONA, kind: "commitments", content: "still owed", assertedAt: old });
    close();

    const out = sink();
    const r = await runMemoryMaintenance({ dbPath, persona: PERSONA, out });
    expect(r.errors).toEqual([]);
    expect(r.dormant).toBe(1);
    expect(r.backup?.status).toBe("taken");
    expect(await listRestorePoints(dbPath)).toHaveLength(1);

    const reopened = await openDrawerStore(dbPath);
    try {
      // Dormant, not deleted: still listed, no longer ranked.
      expect(reopened.store.list(PERSONA, "lessons")[0]!.status).toBe("dormant");
      expect(reopened.store.ranked(PERSONA, "lessons")).toHaveLength(0);
      // The commitment is untouched — age makes it urgent, not stale.
      expect(reopened.store.ranked(PERSONA, "commitments")).toHaveLength(1);
    } finally {
      reopened.close();
    }
    await rm(dir, { recursive: true, force: true });
  });

  test("a corrupt database is reported, and the sweep still returns", async () => {
    // Reported rather than thrown: this runs at the tail of a sweep that has
    // already done the expensive cognitive work.
    const dir = await workdir();
    const dbPath = join(dir, "memory.sqlite");
    await writeFile(dbPath, "not a database");

    const out = sink();
    const r = await runMemoryMaintenance({ dbPath, persona: PERSONA, out });
    expect(r.backup?.status).toBe("refused");
    expect(r.errors.join(" ")).toContain("integrity check");
    // The operator gets the recovery command with the fault, not a pointer to
    // a runbook.
    expect(out.text()).toContain("phantombot memory restore");
    await rm(dir, { recursive: true, force: true });
  });
});
