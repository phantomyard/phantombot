import { describe, expect, test } from "bun:test";
import {
  parseAt,
  parseDuration,
  parseEvery,
  parseFor,
  formatLocal,
} from "../src/lib/scheduleParser.ts";

describe("parseDuration", () => {
  test("parses seconds", () => {
    const r = parseDuration("30s");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ms).toBe(30_000);
  });

  test("parses minutes", () => {
    const r = parseDuration("10m");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ms).toBe(600_000);
  });

  test("parses hours", () => {
    const r = parseDuration("5h");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ms).toBe(5 * 60 * 60 * 1000);
  });

  test("parses days", () => {
    const r = parseDuration("2d");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ms).toBe(2 * 24 * 60 * 60 * 1000);
  });

  test("parses weeks", () => {
    const r = parseDuration("1w");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ms).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test("rejects garbage", () => {
    const r = parseDuration("not a duration");
    expect(r.ok).toBe(false);
  });

  test("rejects zero", () => {
    const r = parseDuration("0m");
    expect(r.ok).toBe(false);
  });

  test("case insensitive units", () => {
    const r = parseDuration("10M");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ms).toBe(600_000);
  });
});

describe("parseAt", () => {
  test("parses ISO 8601", () => {
    const r = parseAt("2026-05-07T09:00:00Z");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.firesAt.toISOString()).toBe("2026-05-07T09:00:00.000Z");
  });

  test("parses date + time without seconds", () => {
    const r = parseAt("2026-05-07 09:00");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.firesAt.toISOString()).toBe("2026-05-07T09:00:00.000Z");
  });

  test("rejects nonsense", () => {
    const r = parseAt("whenever");
    expect(r.ok).toBe(false);
  });
});

describe("parseEvery", () => {
  test("1h → top of every hour", () => {
    const r = parseEvery("1h");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cron).toBe("0 */1 * * *");
  });

  test("5m → every 5 minutes", () => {
    const r = parseEvery("5m");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cron).toBe("*/5 * * * *");
  });

  test("30m → every 30 minutes", () => {
    const r = parseEvery("30m");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cron).toBe("*/30 * * * *");
  });

  test("2h → every 2 hours at :00", () => {
    const r = parseEvery("2h");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cron).toBe("0 */2 * * *");
  });

  test("1d → midnight UTC daily", () => {
    const r = parseEvery("1d");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cron).toBe("0 0 */1 * *");
  });

  test("1w → midnight UTC Sunday", () => {
    const r = parseEvery("1w");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cron).toBe("0 0 * * 0");
  });

  test("rejects sub-minute", () => {
    const r = parseEvery("30s");
    expect(r.ok).toBe(false);
  });

  test("rejects garbage", () => {
    const r = parseEvery("banana");
    expect(r.ok).toBe(false);
  });

  test("rejects multi-week intervals (cron drift at month boundaries)", () => {
    const r = parseEvery("2w");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("drifts");
  });

  test("rejects 4w as well (forces user to 1w or one-off)", () => {
    const r = parseEvery("4w");
    expect(r.ok).toBe(false);
  });
});

describe("parseFor", () => {
  test("30d → correct ms", () => {
    const r = parseFor("30d");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ms).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

describe("formatLocal", () => {
  test("produces readable string", () => {
    const d = new Date("2026-05-06T09:00:00Z");
    const s = formatLocal(d);
    expect(s.length).toBeGreaterThan(10);
  });
});
