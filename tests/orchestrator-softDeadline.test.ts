/**
 * Soft-deadline fitting under a chain deadline (issue #668).
 */
import { describe, expect, test } from "bun:test";
import {
  CHAIN_SOFT_FRACTION,
  MIN_CHAIN_WRAPUP_MS,
  fitSoftTimeoutToCap,
} from "../src/orchestrator/softDeadline.ts";

describe("fitSoftTimeoutToCap (#668)", () => {
  test("the issue's case: 3000s soft against a 1800s wake cap fits to 80% of the cap", () => {
    expect(fitSoftTimeoutToCap(3_000_000, 1_800_000)).toBe(1_440_000);
  });

  test("a soft deadline already under the cap is left exactly as configured", () => {
    expect(fitSoftTimeoutToCap(3_000_000, 3_600_000)).toBe(3_000_000);
    expect(fitSoftTimeoutToCap(60_000, 1_800_000)).toBe(60_000);
  });

  test("soft EQUAL to the cap is not 'under' it — it is fitted", () => {
    expect(fitSoftTimeoutToCap(1_800_000, 1_800_000)).toBe(1_440_000);
  });

  test("disabled stays disabled: 0, negative and undefined never arm", () => {
    expect(fitSoftTimeoutToCap(0, 1_800_000)).toBeUndefined();
    expect(fitSoftTimeoutToCap(-1, 1_800_000)).toBeUndefined();
    expect(fitSoftTimeoutToCap(undefined, 1_800_000)).toBeUndefined();
  });

  test("no hard cap: nothing to fit under, the configured value stands", () => {
    expect(fitSoftTimeoutToCap(3_000_000, undefined)).toBe(3_000_000);
  });

  test("a cap too short to leave a useful wrap-up window disarms instead of fitting", () => {
    // The smallest cap whose 20% remainder is still a full wrap-up window.
    const smallestUseful = MIN_CHAIN_WRAPUP_MS / (1 - CHAIN_SOFT_FRACTION);
    expect(fitSoftTimeoutToCap(3_000_000, smallestUseful)).toBe(
      Math.floor(smallestUseful * CHAIN_SOFT_FRACTION),
    );
    expect(fitSoftTimeoutToCap(3_000_000, smallestUseful - 1_000)).toBeUndefined();
    expect(fitSoftTimeoutToCap(3_000_000, 5_000)).toBeUndefined();
  });

  test("the fitted value always leaves the wrap-up window before the kill", () => {
    for (const cap of [150_000, 600_000, 1_800_000, 3_600_000, 7_200_000]) {
      const fitted = fitSoftTimeoutToCap(Number.MAX_SAFE_INTEGER, cap)!;
      expect(fitted).toBeLessThan(cap);
      expect(cap - fitted).toBeGreaterThanOrEqual(MIN_CHAIN_WRAPUP_MS);
    }
  });
});
