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

  test("a sibling's fresh snapshot is not an error in the ledger (#495)", async () => {
    // Two personas, one shared memory.sqlite, one day rollover: since #490
    // both sweeps run. The second must not record `snapshot: disk I/O error`,
    // because that failure sticks in the nightly ledger and leaves
    // `doctor --persona <p>` permanently red on a host that is in fact backed
    // up by its sibling.
    const dir = await workdir();
    const dbPath = join(dir, "memory.sqlite");
    const now = new Date("2026-08-29T14:43:18.000Z");

    const first = await runMemoryMaintenance({ dbPath, persona: "lena", now });
    expect(first.backup?.status).toBe("taken");
    expect(first.errors).toEqual([]);

    const out = sink();
    const second = await runMemoryMaintenance({
      dbPath,
      persona: "kai",
      now: new Date(now.getTime() + 60),
      out,
    });
    expect(second.backup?.status).toBe("fresh");
    expect(second.errors).toEqual([]);
    expect(out.text()).toContain("snapshot skipped");
    expect(await listRestorePoints(dbPath)).toHaveLength(1);

    await rm(dir, { recursive: true, force: true });
  });
});

describe("commitment hygiene (#763)", () => {
  test("expires empty, scheduler-format and duplicate commitments only, never deletes", async () => {
    const dir = await workdir();
    const dbPath = join(dir, "memory.sqlite");
    const { store, close } = await openDrawerStore(dbPath);
    const at = (d: string) => new Date(`2026-${d}T00:00:00Z`);
    const f = (content: string, d: string, kind: "commitments" | "lessons" = "commitments") =>
      store.file({ persona: PERSONA, kind, content, assertedAt: at(d) }).id;
    const ids = {
      empty: f("", "10-01"),
      blank: f("  -- ?! ", "10-01"),
      stampOnly: f("[commitment]  · 09:31Z", "10-01"),
      scheduler: f("[commitment] task 42: check the inbox — fires 2026-10-02T09:00:00Z", "10-01"),
      dupOld: f("[commitment] Renew the Kospel warranty · 08:00Z", "10-01"),
      dupMid: f("renew   the kospel WARRANTY", "10-02"),
      dupNew: f("Renew the Kospel warranty · 11:15Z", "10-03"),
      normal: f("pay the 2019 tax bill", "01-01"),
      lesson: f("", "10-01", "lessons"),
    };
    close();
    expect(new Set(Object.values(ids)).size).toBe(Object.keys(ids).length);

    const out = sink();
    const r = await runMemoryMaintenance({ dbPath, persona: PERSONA, out, skipSnapshot: true });
    expect(r.errors).toEqual([]);
    expect(r.commitmentHygiene).toEqual({ empty: 3, scheduler: 1, duplicate: 2 });
    expect(out.text()).toContain("nightly: 6 commitment(s) expired by hygiene (empty 3, scheduler 1, duplicate 2)");

    const re = await openDrawerStore(dbPath);
    try {
      const status = new Map(
        [...re.store.list(PERSONA, "commitments"), ...re.store.list(PERSONA, "lessons")].map((e) => [e.id, e.status]),
      );
      expect(status.size).toBe(Object.keys(ids).length); // nothing deleted
      for (const k of ["empty", "blank", "stampOnly", "scheduler", "dupOld", "dupMid"] as const) {
        expect([k, status.get(ids[k])]).toEqual([k, "expired"]);
      }
      expect(status.get(ids.dupNew)).toBe("active");
      expect(status.get(ids.normal)).toBe("active");
      expect(status.get(ids.lesson)).toBe("active");
    } finally {
      re.close();
    }

    const out2 = sink();
    const r2 = await runMemoryMaintenance({ dbPath, persona: PERSONA, out: out2, skipSnapshot: true });
    expect(r2.commitmentHygiene).toEqual({ empty: 0, scheduler: 0, duplicate: 0 });
    expect(out2.text()).not.toContain("hygiene");
    await rm(dir, { recursive: true, force: true });
  });
});
