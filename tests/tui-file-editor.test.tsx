/**
 * The file editor is an APP SCREEN, not a borrowed vim.
 *
 * The assertions that matter are about safety, not looks: esc on a clean file
 * leaves immediately, esc on a dirty file asks before discarding, and choosing
 * Save & exit really writes the file. No external process is spawned — the
 * whole point of this screen is that the `$EDITOR` handover is gone.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";

import { FileEditorScreen } from "../src/tui/screens/FileEditor.tsx";
import { TerminalSizeContext } from "../src/tui/terminal.ts";
import { stripAnsi } from "./helpers/ansi.ts";

const dir = mkdtempSync(join(tmpdir(), "tui-file-editor-"));

let mounted: Array<() => void> = [];
afterEach(() => {
  for (const c of mounted) c();
  mounted = [];
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mount(
  path: string,
  onBack: (r: unknown) => void,
  size?: { rows: number; columns: number },
) {
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
    write: (c: string) => void;
  };
  stdout.columns = 140;
  stdout.rows = 40;
  stdout.write = (c: string) => void frames.push(c);
  const instance = render(
    size ? (
      <TerminalSizeContext.Provider value={size}>
        <FileEditorScreen path={path} personaName="testbot" onBack={onBack} />
      </TerminalSizeContext.Provider>
    ) : (
      <FileEditorScreen
        path={path}
        personaName="testbot"
        onBack={onBack}
      />
    ),
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
    // 120ms: Ink disambiguates a lone ESC from escape sequences on a timer,
    // and 60ms was occasionally inside that window.
    press: async (bytes: string) => {
      stdin.write(bytes);
      await sleep(120);
    },
  };
}

describe("the file editor is an app screen", () => {
  test("an unreadable file shows the error and never lets a save through", async () => {
    // The regression: a read failure used to collapse to an EMPTY buffer,
    // and ^s would write that emptiness back over the real contents.
    // chmod 0000 makes the read fail while any later write would succeed —
    // exactly the dangerous direction.
    const path = join(dir, "SOUL-locked.md");
    writeFileSync(path, "IMPORTANT CONTENT\nline2\n");
    chmodSync(path, 0o000);
    try {
      let back: { saved: boolean; changed: boolean } | undefined;
      const app = mount(path, (r) => {
        back = r as { saved: boolean; changed: boolean };
      });
      await sleep(120);
      expect(app.frame()).toContain("cannot read");
      // ^s must do nothing — the buffer never existed.
      await app.press("\x13");
      // esc is the only way out, and it reports a clean exit.
      await app.press("\x1b");
      expect(back).toEqual({ saved: false, changed: false });
    } finally {
      chmodSync(path, 0o644);
    }
    // The contents survived the whole encounter with the editor.
    expect(readFileSync(path, "utf8")).toContain("IMPORTANT CONTENT");
  });

  test("the text area fills the window down to the footer", async () => {
    const path = join(dir, "SOUL-fill.md");
    writeFileSync(path, "# Soul\nshort file");
    const app = mount(path, () => {}, { rows: 40, columns: 140 });
    await sleep(80);
    const lines = app.frame().split("\n");
    // The whole window is painted (minus Ink's reserved row) and the footer
    // key-hint bar is the LAST row — the editor never floats above dead space.
    expect(lines.length).toBe(39);
    expect(lines[lines.length - 1]).toContain("Back");
  });

  test("it renders the file and wears the chrome", async () => {
    const path = join(dir, "SOUL-chrome.md");
    writeFileSync(path, "# Soul\nbe brief");
    let closed = false;
    const app = mount(path, () => {
      closed = true;
    });
    await sleep(80);
    expect(app.frame()).toContain("be brief");
    expect(app.frame()).toContain("SOUL-chrome.md");
    expect(closed).toBe(false);
  });

  test("esc on a CLEAN file goes straight back, unchanged", async () => {
    const path = join(dir, "SOUL-clean.md");
    writeFileSync(path, "unchanged");
    const results: Array<Record<string, unknown>> = [];
    const app = mount(path, (r) => results.push(r as Record<string, unknown>));
    await sleep(80);
    await app.press("\x1b");
    expect(results).toEqual([{ saved: false, changed: false }]);
    expect(readFileSync(path, "utf8")).toBe("unchanged");
  });

  test("esc on a DIRTY file opens the menu; Discard leaves the file alone", async () => {
    const path = join(dir, "SOUL-dirty.md");
    writeFileSync(path, "original");
    const results: Array<Record<string, unknown>> = [];
    const app = mount(path, (r) => results.push(r as Record<string, unknown>));
    await sleep(80);
    await app.press("X");
    expect(app.frame()).toContain("modified");
    await app.press("\x1b");
    expect(app.frame()).toContain("Save & exit");
    expect(app.frame()).toContain("Discard changes");
    expect(app.frame()).toContain("Cancel");
    await app.press("\x1b"); // esc in the menu cancels back to the editor
    expect(app.frame()).not.toContain("Discard changes");
    await app.press("\x1b"); // dirty again → menu
    await app.press("\x1b[B"); // down to Discard changes
    await app.press("\r");
    expect(results).toEqual([{ saved: false, changed: true }]);
    expect(readFileSync(path, "utf8")).toBe("original");
  });

  test("Save & exit writes the file through", async () => {
    const path = join(dir, "AGENTS-save.md");
    writeFileSync(path, "before");
    const results: Array<Record<string, unknown>> = [];
    const app = mount(path, (r) => results.push(r as Record<string, unknown>));
    await sleep(80);
    await app.press("hello ");
    await app.press("\x1b"); // dirty → menu
    await app.press("\r"); // Save & exit is the first item
    await sleep(80);
    expect(results).toEqual([{ saved: true, changed: true }]);
    expect(readFileSync(path, "utf8")).toBe("hello before");
  });

  test("^s saves in place without leaving", async () => {
    const path = join(dir, "IDENTITY-ctrls.md");
    writeFileSync(path, "who");
    let closed = false;
    const app = mount(path, () => {
      closed = true;
    });
    await sleep(80);
    await app.press("a");
    await app.press("\x13"); // ctrl+s
    await sleep(80);
    expect(readFileSync(path, "utf8")).toBe("awho");
    expect(closed).toBe(false); // still on the screen, cursor kept
  });
});
