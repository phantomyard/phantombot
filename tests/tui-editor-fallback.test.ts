import { describe, expect, test } from "bun:test";
import { FRIENDLY_EDITORS, resolveFallbackEditor } from "../src/tui/actions";

describe("fallback editor", () => {
  test("prefers a modeless editor over vi", () => {
    expect(resolveFallbackEditor(() => true)).toBe("nano");
  });

  test("walks the list when the friendlier ones are missing", () => {
    expect(resolveFallbackEditor((c) => c === "micro")).toBe("micro");
    expect(resolveFallbackEditor((c) => c === "pico")).toBe("pico");
  });

  test("falls back to vi when nothing else is installed", () => {
    expect(resolveFallbackEditor(() => false)).toBe("vi");
  });

  test("vi is last, not absent", () => {
    expect(FRIENDLY_EDITORS[FRIENDLY_EDITORS.length - 1]).toBe("vi");
  });
});
