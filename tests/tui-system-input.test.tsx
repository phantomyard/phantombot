import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { render } from "ink";

import { SystemScreen } from "../src/tui/screens/System.tsx";
import type { SystemSnapshot } from "../src/tui/systemSnapshot.ts";
import { stripAnsi } from "./helpers/ansi.ts";
import type { HostSnapshot } from "../src/tui/snapshot.ts";
import type { LogSource } from "../src/tui/logSources.ts";
import type { LogLine } from "../src/tui/logBuffer.ts";

const TEST_HOST = {
  version: "test",
  updateChannel: "stable",
  defaultPersona: "kai",
  personasDir: "/tmp/none",
  personas: [],
} satisfies HostSnapshot;

const mounted: Array<() => void> = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(onBack: () => void, sources: LogSource[] = []) {
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: () => void;
    ref: () => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  const frames: string[] = [];
  const stdout = new EventEmitter() as EventEmitter & {
    columns: number;
    rows: number;
    write: (chunk: string) => void;
  };
  stdout.columns = 120;
  stdout.rows = 40;
  stdout.write = (chunk) => void frames.push(chunk);
  const snapshot: SystemSnapshot = {
    capturedAt: "2026-09-01T12:00:00Z",
    services: [],
  };
  const instance = render(
    <SystemScreen
      snapshot={snapshot}
      host={TEST_HOST}
      personas={["kai"]}
      onBack={onBack}
      sources={sources}
    />,
    {
      stdin: stdin as never,
      stdout: stdout as never,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    },
  );
  mounted.push(() => instance.unmount());
  return {
    frame: () => stripAnsi(frames.at(-1) ?? ""),
    press: async (bytes: string) => {
      stdin.write(bytes);
      await sleep(60);
    },
  };
}

describe("System log search input", () => {
  test("search focus accepts letters reserved for tab and filter shortcuts", async () => {
    const app = mount(() => {});
    await app.press("\t");
    await app.press("/");
    await app.press("load vault topic");
    expect(app.frame()).toContain("filter: load vault topic ◂ typing");
    expect(app.frame()).toContain("system ▸ logs");
  });

  test("escape leaves search focus before leaving the screen", async () => {
    let backs = 0;
    const app = mount(() => backs++);
    await app.press("\t");
    await app.press("/");
    await app.press("vault");
    await app.press("\x1b");
    expect(backs).toBe(0);
    expect(app.frame()).toContain("filter: vault (/ to search)");
    await app.press("\x1b");
    expect(backs).toBe(1);
  });
});

/** A source with more lines than any terminal window can hold at once. */
function tallSource(count: number): LogSource {
  const lines: LogLine[] = Array.from({ length: count }, (_, i) => ({
    at: Date.UTC(2026, 8, 1, 12, 0, 0) + i * 1000,
    level: "info",
    msg: `line-${String(i).padStart(3, "0")}`,
    type: "test",
    raw: "",
  }));
  return {
    id: "session",
    label: "session",
    location: "/tmp/tall.log",
    command: "cat /tmp/tall.log",
    available: true,
    read: async () => lines,
  };
}

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const HOME = "\x1b[H";
const END = "\x1b[F";

describe("System log scrollback", () => {
  // The bug this pane shipped with: it rendered `slice(-rows)`, so every line
  // read beyond the last screenful was unreachable. Pressing home must reach
  // the OLDEST line, not just re-draw the newest ones.
  test("home reaches the oldest line and end returns to live", async () => {
    const app = mount(() => {}, [tallSource(200)]);
    await app.press("\t");
    expect(app.frame()).toContain("line-199");
    expect(app.frame()).toContain("following");

    await app.press(HOME);
    const top = app.frame();
    expect(top).toContain("line-000");
    expect(top).not.toContain("line-199");
    expect(top).toContain("from live");

    await app.press(END);
    const live = app.frame();
    expect(live).toContain("line-199");
    expect(live).toContain("following");
  });

  test("arrows move one line and page keys move a screenful", async () => {
    const app = mount(() => {}, [tallSource(200)]);
    await app.press("\t");
    await app.press(UP);
    const oneUp = app.frame();
    expect(oneUp).toContain("line-198");
    expect(oneUp).not.toContain("line-199");

    await app.press(PAGE_UP);
    const paged = app.frame();
    expect(paged).not.toContain("line-198");
    expect(paged).toContain("older");

    await app.press(PAGE_DOWN);
    await app.press(DOWN);
    expect(app.frame()).toContain("line-199");
  });

  test("scrolling past the ends clamps instead of stranding the window", async () => {
    const app = mount(() => {}, [tallSource(200)]);
    await app.press("\t");
    await app.press(HOME);
    // Three pages that have nowhere to go.
    for (const _ of Array(3)) await app.press(PAGE_UP);
    expect(app.frame()).toContain("line-000");
    // One press back down must move exactly one line — proof the offset was
    // clamped rather than inflated by the presses that had nowhere to go.
    await app.press(DOWN);
    expect(app.frame()).not.toContain("line-000");
  });

  test("scroll keys work while the search box has focus", async () => {
    const app = mount(() => {}, [tallSource(200)]);
    await app.press("\t");
    await app.press("/");
    await app.press("line");
    await app.press(HOME);
    const frame = app.frame();
    expect(frame).toContain("line-000");
    expect(frame).toContain("filter: line ◂ typing");
  });

  test("a stream that fits shows no scroll markers", async () => {
    const app = mount(() => {}, [tallSource(3)]);
    await app.press("\t");
    const frame = app.frame();
    expect(frame).toContain("line-000");
    expect(frame).toContain("line-002");
    expect(frame).not.toContain("older");
    expect(frame).not.toContain("newer");
  });
});
