import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { forceRepaint, gateStdout } from "../src/tui/terminal.ts";

function fakeStdout(columns: number) {
  const stream = new EventEmitter() as unknown as NodeJS.WriteStream & {
    columns: number;
  };
  stream.columns = columns;
  (stream as unknown as { write: (c: string) => boolean }).write = () => true;
  return stream;
}

describe("forceRepaint", () => {
  test("takes Ink's narrower-terminal branch, then restores the real width", () => {
    const stdout = fakeStdout(120);
    const gate = gateStdout(stdout);
    const widths: number[] = [];
    stdout.on("resize", () => widths.push(gate.stream.columns));

    forceRepaint(gate, stdout);

    // First resize must report a SMALLER width — that is the only branch on
    // which Ink clears the screen and forgets its last frame.
    expect(widths.length).toBe(2);
    expect(widths[0]).toBeLessThan(120);
    // ...and the app must be left seeing the real terminal again.
    expect(widths[1]).toBe(120);
    expect(gate.stream.columns).toBe(120);
  });

  test("never claims a width below one column", () => {
    const stdout = fakeStdout(1);
    const gate = gateStdout(stdout);
    const widths: number[] = [];
    stdout.on("resize", () => widths.push(gate.stream.columns));
    forceRepaint(gate, stdout);
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(1);
  });
});
