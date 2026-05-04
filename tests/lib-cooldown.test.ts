/**
 * Tests for the per-harness cooldown store. Pure module — no
 * subprocesses, no real time. The store takes injectable random()
 * and now() seams so we can pin both.
 */

import { describe, expect, test } from "bun:test";
import {
  applyJitter,
  baseCooldownForFailures,
  BASE_COOLDOWN_MS,
  CooldownStore,
  JITTER_RATIO,
  MAX_COOLDOWN_MS,
} from "../src/lib/cooldown.ts";

describe("baseCooldownForFailures", () => {
  test("doubles each step from 150s up to a 1h cap", () => {
    expect(baseCooldownForFailures(0)).toBe(0);
    expect(baseCooldownForFailures(1)).toBe(150_000);
    expect(baseCooldownForFailures(2)).toBe(300_000);
    expect(baseCooldownForFailures(3)).toBe(600_000);
    expect(baseCooldownForFailures(4)).toBe(1_200_000);
    expect(baseCooldownForFailures(5)).toBe(2_400_000);
    expect(baseCooldownForFailures(6)).toBe(MAX_COOLDOWN_MS); // 3_600_000
  });

  test("caps at MAX_COOLDOWN_MS for huge failure counts", () => {
    expect(baseCooldownForFailures(100)).toBe(MAX_COOLDOWN_MS);
    expect(baseCooldownForFailures(1_000_000)).toBe(MAX_COOLDOWN_MS);
  });
});

describe("applyJitter", () => {
  test("random=0 → factor 1 - JITTER_RATIO (lower bound)", () => {
    // 100_000 * (1 - 0.25) = 75_000
    expect(applyJitter(100_000, () => 0)).toBe(75_000);
  });

  test("random=0.5 → factor exactly 1 (no jitter)", () => {
    expect(applyJitter(100_000, () => 0.5)).toBe(100_000);
  });

  test("random just under 1 → factor approaches 1 + JITTER_RATIO (upper bound)", () => {
    // 100_000 * (1 + 0.25 - epsilon) ≈ 125_000
    expect(applyJitter(100_000, () => 0.999_999)).toBe(125_000);
  });

  test("output stays within [base*0.75, base*1.25] across many random samples", () => {
    const lo = Math.floor(BASE_COOLDOWN_MS * (1 - JITTER_RATIO));
    const hi = Math.ceil(BASE_COOLDOWN_MS * (1 + JITTER_RATIO));
    for (let i = 0; i < 1000; i++) {
      const r = Math.random();
      const out = applyJitter(BASE_COOLDOWN_MS, () => r);
      expect(out).toBeGreaterThanOrEqual(lo);
      expect(out).toBeLessThanOrEqual(hi);
    }
  });
});

describe("CooldownStore — basic state machine", () => {
  test("untouched id → cooled=false, no consecutive failures", () => {
    const s = new CooldownStore();
    const status = s.isCooledDown("gemini");
    expect(status).toEqual({
      cooled: false,
      untilMs: 0,
      consecutiveFailures: 0,
    });
  });

  test("markFailure once → cooled with first-tier window (~150s, jittered)", () => {
    let now = 1_000_000;
    const s = new CooldownStore(
      () => 0.5, // no jitter
      () => now,
    );
    const result = s.markFailure("gemini");
    expect(result.cooled).toBe(true);
    expect(result.consecutiveFailures).toBe(1);
    expect(result.untilMs).toBe(now + BASE_COOLDOWN_MS);
    // Just before the window expires → still cooled.
    now += BASE_COOLDOWN_MS - 1;
    expect(s.isCooledDown("gemini").cooled).toBe(true);
    // At the window edge → no longer cooled.
    now += 1;
    const after = s.isCooledDown("gemini");
    expect(after.cooled).toBe(false);
    // Counter is preserved across the cooldown expiry — only success clears.
    expect(after.consecutiveFailures).toBe(1);
  });

  test("markFailure repeated → window doubles each time, capped at 1h", () => {
    let now = 0;
    const s = new CooldownStore(
      () => 0.5,
      () => now,
    );
    const widths: number[] = [];
    for (let i = 0; i < 8; i++) {
      const r = s.markFailure("gemini");
      widths.push(r.untilMs - now);
    }
    expect(widths).toEqual([
      150_000, // failures=1
      300_000, // failures=2
      600_000, // failures=3
      1_200_000, // failures=4
      2_400_000, // failures=5
      3_600_000, // failures=6 (cap)
      3_600_000, // failures=7 (still capped)
      3_600_000, // failures=8 (still capped)
    ]);
  });

  test("markSuccess clears consecutive failures and active cooldown", () => {
    let now = 0;
    const s = new CooldownStore(
      () => 0.5,
      () => now,
    );
    s.markFailure("gemini");
    s.markFailure("gemini");
    expect(s.isCooledDown("gemini").consecutiveFailures).toBe(2);

    s.markSuccess("gemini");
    expect(s.isCooledDown("gemini")).toEqual({
      cooled: false,
      untilMs: 0,
      consecutiveFailures: 0,
    });

    // Next failure restarts at the first-tier window.
    const r = s.markFailure("gemini");
    expect(r.consecutiveFailures).toBe(1);
    expect(r.untilMs - now).toBe(BASE_COOLDOWN_MS);
  });

  test("near-immediate re-failure after window expiry continues the backoff", () => {
    let now = 0;
    const s = new CooldownStore(
      () => 0.5,
      () => now,
    );
    s.markFailure("gemini"); // window: 150s
    now += BASE_COOLDOWN_MS + 1; // expire it
    expect(s.isCooledDown("gemini").cooled).toBe(false);
    // Next failure should land at TIER 2 (300s), not restart at 150s,
    // because we haven't seen a success — the cooldown window expiring
    // doesn't reset the failure count.
    const r = s.markFailure("gemini");
    expect(r.consecutiveFailures).toBe(2);
    expect(r.untilMs - now).toBe(300_000);
  });

  test("state is keyed per harness id — failures on gemini don't cool pi", () => {
    let now = 0;
    const s = new CooldownStore(
      () => 0.5,
      () => now,
    );
    s.markFailure("gemini");
    s.markFailure("gemini");
    s.markFailure("gemini");
    expect(s.isCooledDown("gemini").cooled).toBe(true);
    expect(s.isCooledDown("pi").cooled).toBe(false);
    expect(s.isCooledDown("claude").cooled).toBe(false);
  });

  test("clear() drops everything", () => {
    const s = new CooldownStore(() => 0.5);
    s.markFailure("gemini");
    s.markFailure("pi");
    s.clear();
    expect(s.isCooledDown("gemini").cooled).toBe(false);
    expect(s.isCooledDown("pi").cooled).toBe(false);
  });
});
