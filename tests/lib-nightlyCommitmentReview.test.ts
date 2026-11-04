/**
 * Nightly commitment review (#767): a percentage batch, verdicts applied in
 * code and scoped to the batch, ambiguity keeps, an errored turn changes
 * nothing, and the cursor moves on.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMMITMENT_REVIEW_FRACTION,
  parseReviewVerdicts,
  runCommitmentReview,
} from "../src/lib/nightlyCommitmentReview.ts";
import { openDrawerStore } from "../src/memory/drawerSync.ts";

const PERSONA = "robbie";
const DAY = 86_400_000;

async function seeded(n: number): Promise<{ dbPath: string; ids: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "pb-review-"));
  const dbPath = join(dir, "memory.sqlite");
  const { store, close } = await openDrawerStore(dbPath);
  const ids: string[] = [];
  try {
    // ids[0] is the OLDEST.
    for (let i = 0; i < n; i++) {
      ids.push(
        store.file({
          persona: PERSONA,
          kind: "commitments",
          content: `obligation ${i}`,
          assertedAt: new Date(Date.now() - (n - i) * DAY),
        }).id,
      );
    }
  } finally {
    close();
  }
  return { dbPath, ids };
}

async function statusOf(dbPath: string, id: string): Promise<string | undefined> {
  const { store, close } = await openDrawerStore(dbPath);
  try {
    return store.get(id)?.status;
  } finally {
    close();
  }
}

describe("commitment review batch", () => {
  test("is 5% of open commitments, rounded up, oldest first", async () => {
    expect(COMMITMENT_REVIEW_FRACTION).toBe(0.05);
    const { dbPath, ids } = await seeded(41);
    const prompts: string[] = [];
    const r = await runCommitmentReview({
      dbPath,
      persona: PERSONA,
      today: "2026-11-04",
      runOne: async (p) => {
        prompts.push(p);
        return { finalReply: "" };
      },
    });
    // ceil(41 * 0.05) = 3
    expect(r!.reviewed).toBe(3);
    for (const id of ids.slice(0, 3)) expect(prompts[0]).toContain(id);
    expect(prompts[0]).not.toContain(ids[3]!);
  });

  test("the cursor moves on: kept rows are not re-read next night", async () => {
    const { dbPath, ids } = await seeded(20);
    const seen: string[] = [];
    for (let night = 0; night < 3; night++) {
      await runCommitmentReview({
        dbPath,
        persona: PERSONA,
        today: "2026-11-04",
        now: new Date(Date.now() + night * DAY),
        runOne: async (p) => {
          seen.push(ids.find((id) => p.includes(id))!);
          return { finalReply: "" };
        },
      });
    }
    // ceil(20 * 0.05) = 1 per night, a different row each night.
    expect(seen).toEqual(ids.slice(0, 3));
  });

  test("nothing open, no turn", async () => {
    const { dbPath } = await seeded(0);
    let called = false;
    const r = await runCommitmentReview({
      dbPath,
      persona: PERSONA,
      today: "2026-11-04",
      runOne: async () => {
        called = true;
        return { finalReply: "" };
      },
    });
    expect(r).toBeNull();
    expect(called).toBe(false);
  });
});

describe("commitment review verdicts", () => {
  test("applies DISCHARGE/EXPIRE for batch ids only; KEEP and silence keep", async () => {
    const { dbPath, ids } = await seeded(80); // batch = 4
    const outsider = ids[50]!;
    const r = await runCommitmentReview({
      dbPath,
      persona: PERSONA,
      today: "2026-11-04",
      runOne: async () => ({
        finalReply: [
          `DISCHARGE ${ids[0]}`,
          `- EXPIRE \`${ids[1]}\``,
          `KEEP ${ids[2]}`,
          `EXPIRE ${outsider}`,
        ].join("\n"),
      }),
    });
    expect(r).toMatchObject({ reviewed: 4, discharged: 1, expired: 1 });
    expect(await statusOf(dbPath, ids[0]!)).toBe("discharged");
    expect(await statusOf(dbPath, ids[1]!)).toBe("expired");
    expect(await statusOf(dbPath, ids[2]!)).toBe("active");
    expect(await statusOf(dbPath, ids[3]!)).toBe("active");
    expect(await statusOf(dbPath, outsider)).toBe("active");
  });

  test("an errored turn changes nothing and the same rows come back", async () => {
    const { dbPath, ids } = await seeded(20);
    const r = await runCommitmentReview({
      dbPath,
      persona: PERSONA,
      today: "2026-11-04",
      runOne: async () => ({ finalReply: `EXPIRE ${ids[0]}`, errored: "timeout" }),
    });
    expect(r!.error).toBe("timeout");
    expect(await statusOf(dbPath, ids[0]!)).toBe("active");
    let again = "";
    await runCommitmentReview({
      dbPath,
      persona: PERSONA,
      today: "2026-11-05",
      runOne: async (p) => {
        again = p;
        return { finalReply: "" };
      },
    });
    expect(again).toContain(ids[0]!);
  });

  test("conflicting verdicts for one id are ambiguous and keep", () => {
    const id = "0123456789abcdef";
    expect(parseReviewVerdicts(`DISCHARGE ${id}\nKEEP ${id}`, [id]).size).toBe(0);
    expect(parseReviewVerdicts(`KEEP ${id}\nEXPIRE ${id}`, [id]).size).toBe(0);
    expect(parseReviewVerdicts(`EXPIRE ${id}\nDISCHARGE ${id}`, [id]).size).toBe(0);
    const w = parseReviewVerdicts(`expire ${id}\nEXPIRE ${id}`, [id]);
    expect(w.get(id)).toBe("expired");
  });

  test("a row already closed by a live turn is left as it is", async () => {
    const { dbPath, ids } = await seeded(20);
    const r = await runCommitmentReview({
      dbPath,
      persona: PERSONA,
      today: "2026-11-04",
      runOne: async () => {
        const { store, close } = await openDrawerStore(dbPath);
        store.setStatus(ids[0]!, "discharged");
        close();
        return { finalReply: `EXPIRE ${ids[0]}` };
      },
    });
    expect(r!.expired).toBe(0);
    expect(await statusOf(dbPath, ids[0]!)).toBe("discharged");
  });
});
