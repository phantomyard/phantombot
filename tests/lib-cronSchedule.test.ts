import { describe, expect, test } from "bun:test";
import {
  classifyCadence,
  defaultReviewIntervalMs,
  nextFire,
  validateCron,
} from "../src/lib/cronSchedule.ts";

describe("validateCron", () => {
  test("standard hourly is fine", () => {
    expect(validateCron("0 * * * *").ok).toBe(true);
  });

  test("daily at 02:00 is fine", () => {
    expect(validateCron("0 2 * * *").ok).toBe(true);
  });

  test("Saturday midnight is fine", () => {
    expect(validateCron("0 0 * * 6").ok).toBe(true);
  });

  test("garbage is rejected with a message", () => {
    const r = validateCron("not a cron");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });

  test("missing field is rejected", () => {
    expect(validateCron("0 * *").ok).toBe(false);
  });
});

describe("nextFire", () => {
  test("hourly from :30 → top of next hour", () => {
    const next = nextFire("0 * * * *", new Date("2026-05-02T09:30:00Z"));
    expect(next.toISOString()).toBe("2026-05-02T10:00:00.000Z");
  });

  test("daily at 02:00 from 03:00 → next day at 02:00 UTC", () => {
    const next = nextFire("0 2 * * *", new Date("2026-05-02T03:00:00Z"));
    expect(next.toISOString()).toBe("2026-05-03T02:00:00.000Z");
  });

  test("Saturday midnight from a Saturday afternoon → following Saturday 00:00", () => {
    // 2026-05-02 is a Saturday.
    const next = nextFire("0 0 * * 6", new Date("2026-05-02T14:00:00Z"));
    // Next Saturday is 2026-05-09.
    expect(next.toISOString()).toBe("2026-05-09T00:00:00.000Z");
  });
});

describe("classifyCadence", () => {
  test("every minute → subhourly", () => {
    expect(classifyCadence("* * * * *")).toBe("subhourly");
  });

  test("hourly → hourly", () => {
    expect(classifyCadence("0 * * * *")).toBe("hourly");
  });

  test("daily → daily", () => {
    expect(classifyCadence("0 9 * * *")).toBe("daily");
  });

  test("weekly → weekly", () => {
    expect(classifyCadence("0 0 * * 1")).toBe("weekly");
  });

  test("monthly → monthly", () => {
    expect(classifyCadence("0 0 1 * *")).toBe("monthly");
  });
});

describe("defaultReviewIntervalMs", () => {
  test("review intervals scale with cadence (subhourly < hourly < daily < weekly < monthly)", () => {
    const sh = defaultReviewIntervalMs("subhourly");
    const hr = defaultReviewIntervalMs("hourly");
    const da = defaultReviewIntervalMs("daily");
    const wk = defaultReviewIntervalMs("weekly");
    const mo = defaultReviewIntervalMs("monthly");
    expect(sh).toBeLessThan(hr);
    expect(hr).toBeLessThan(da);
    expect(da).toBeLessThan(wk);
    expect(wk).toBeLessThan(mo);
  });

  test("hourly review is 14 days", () => {
    expect(defaultReviewIntervalMs("hourly")).toBe(14 * 24 * 60 * 60 * 1000);
  });
});
