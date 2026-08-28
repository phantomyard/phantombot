/**
 * Absolute hit-rect position (issue #471).
 *
 * This is a REGRESSION test for a bug that shipped in the first cut and was
 * caught by driving a real terminal: Yoga's `getComputedLeft`/`getComputedTop`
 * are relative to the node's PARENT, not to the screen. Using them directly
 * registered every nested row at its container's offset, so clicks landed on
 * nothing at all — silently, because a click that hits no rect is correctly
 * ignored.
 */

import { describe, expect, test } from "bun:test";
import type { DOMElement } from "ink";

import { absolutePosition } from "../src/tui/components/Selectable.tsx";

function node(
  left: number,
  top: number,
  parent?: unknown,
): DOMElement {
  return {
    yogaNode: {
      getComputedLeft: () => left,
      getComputedTop: () => top,
    },
    parentNode: parent,
  } as unknown as DOMElement;
}

describe("absolutePosition", () => {
  test("a root node is its own offset", () => {
    expect(absolutePosition(node(3, 4))).toEqual({ left: 3, top: 4 });
  });

  test("offsets SUM up the parent chain", () => {
    // frame(1,1) → body(1,2) → row(0,3) is at column 2, row 6 — not (0,3).
    const frame = node(1, 1);
    const body = node(1, 2, frame);
    const row = node(0, 3, body);
    expect(absolutePosition(row)).toEqual({ left: 2, top: 6 });
  });

  test("a node with no Yoga anywhere returns undefined, never a wrong rect", () => {
    const bare = { parentNode: undefined } as unknown as DOMElement;
    expect(absolutePosition(bare)).toBeUndefined();
  });

  test("an intermediate node without Yoga is skipped, not fatal", () => {
    const frame = node(2, 2);
    const gap = { parentNode: frame } as unknown as DOMElement;
    const row = node(1, 1, gap);
    expect(absolutePosition(row)).toEqual({ left: 3, top: 3 });
  });
});
