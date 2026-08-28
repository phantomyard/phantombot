import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInEditor } from "../src/tui/actions.ts";

const dir = mkdtempSync(join(tmpdir(), "tui-editor-"));

test("quitting the editor without saving does not claim a save", async () => {
  const path = join(dir, "SOUL.md");
  await Bun.write(path, "hello");
  const r = await openInEditor(path, async () => ({ exitCode: 0 }));
  expect(r.ok).toBe(true);
  expect(r.changed).toBe(false);
});

test("a write in the editor is reported as changed", async () => {
  const path = join(dir, "USER.md");
  await Bun.write(path, "hello");
  const r = await openInEditor(path, async () => {
    await Bun.write(path, "hello there");
    return { exitCode: 0 };
  });
  expect(r.changed).toBe(true);
});

test("creating the file by opening it counts as changed", async () => {
  const path = join(dir, "IDENTITY.md");
  const r = await openInEditor(path, async () => {
    await Bun.write(path, "new");
    return { exitCode: 0 };
  });
  expect(r.changed).toBe(true);
});
