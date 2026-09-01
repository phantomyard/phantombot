import { describe, expect, test } from "bun:test";

import { maxOffset, nudgeOffset, tailViewport } from "../src/tui/logViewport.ts";

describe("tailViewport", () => {
  test("follows the tail at offset 0", () => {
    const view = tailViewport(100, 10, 0);
    expect(view.start).toBe(90);
    expect(view.end).toBe(100);
    expect(view.above).toBe(90);
    expect(view.below).toBe(0);
    expect(view.following).toBe(true);
  });

  test("scrolling back moves the window off the tail", () => {
    const view = tailViewport(100, 10, 25);
    expect(view.start).toBe(65);
    expect(view.end).toBe(75);
    expect(view.below).toBe(25);
    expect(view.following).toBe(false);
  });

  test("the oldest line is reachable and the window never runs off the top", () => {
    const view = tailViewport(100, 10, maxOffset(100, 10));
    expect(view.start).toBe(0);
    expect(view.end).toBe(10);
    expect(view.above).toBe(0);
    expect(view.below).toBe(90);
  });

  test("a stream shorter than the window is shown whole and stays following", () => {
    const view = tailViewport(4, 10, 7);
    expect(view.start).toBe(0);
    expect(view.end).toBe(4);
    expect(view.above).toBe(0);
    expect(view.below).toBe(0);
    expect(view.following).toBe(true);
  });

  test("an empty stream yields an empty window rather than a negative one", () => {
    expect(tailViewport(0, 10, 5)).toEqual({
      start: 0,
      end: 0,
      above: 0,
      below: 0,
      following: true,
      offset: 0,
    });
  });

  // A reload returning fewer lines must not strand the pane on an offset that
  // no longer exists — it slides back toward live instead of going blank.
  test("a shrinking stream re-clamps a stale offset", () => {
    const view = tailViewport(12, 10, 500);
    expect(view.start).toBe(0);
    expect(view.end).toBe(10);
    expect(view.offset).toBe(2);
  });
});

describe("nudgeOffset", () => {
  test("clamps at the oldest line so held keys do not inflate the offset", () => {
    expect(nudgeOffset(90, 1, 100, 10)).toBe(90);
    expect(nudgeOffset(90, 40, 100, 10)).toBe(90);
  });

  test("clamps at the tail rather than going negative", () => {
    expect(nudgeOffset(3, -10, 100, 10)).toBe(0);
  });

  test("moves by whole pages in both directions", () => {
    expect(nudgeOffset(0, 9, 100, 10)).toBe(9);
    expect(nudgeOffset(9, -9, 100, 10)).toBe(0);
  });
});
