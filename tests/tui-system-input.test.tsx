import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { render } from "ink";

import { SystemScreen } from "../src/tui/screens/System.tsx";
import type { SystemSnapshot } from "../src/tui/systemSnapshot.ts";
import { stripAnsi } from "./helpers/ansi.ts";

const mounted: Array<() => void> = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(onBack: () => void) {
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
    <SystemScreen snapshot={snapshot} personas={["kai"]} onBack={onBack} />,
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
