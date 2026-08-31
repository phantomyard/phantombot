/**
 * One design language across every menu (issue #471 follow-up).
 *
 * Reported: menu labels were a mix of `send` / `run again` / `back to chat`,
 * and "back" was `esc` on some screens and `←` on others — so the one key a
 * user needs when lost meant different things depending on where they were.
 *
 * These are SOURCE assertions on purpose: a frame test only sees the screens
 * it happens to mount, and the rule has to hold on the screen nobody wrote a
 * test for. The pairing below (`key` immediately followed by `label`) is what
 * a footer entry looks like; option lists carry `id`/`label` and are not
 * matched.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SCREENS = join(import.meta.dir, "..", "src", "tui", "screens");

function menuItems(): { file: string; key: string; label: string }[] {
  const out: { file: string; key: string; label: string }[] = [];
  const files = [
    ...readdirSync(SCREENS).map((f) => join(SCREENS, f)),
    join(import.meta.dir, "..", "src", "tui", "App.tsx"),
  ].filter((f) => f.endsWith(".tsx"));
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/key: "([^"]+)",\s*\n?\s*label: "([^"]+)"/g)) {
      out.push({ file, key: m[1]!, label: m[2]! });
    }
  }
  return out;
}

describe("menu design language", () => {
  test("every menu item is found — the scan itself must not go silent", () => {
    // A regex that matches nothing would make every rule below vacuously true.
    expect(menuItems().length).toBeGreaterThan(25);
  });

  test("every menu label starts with a capital", () => {
    const bad = menuItems().filter((i) => i.label[0] !== i.label[0]!.toUpperCase());
    expect(bad.map((i) => `${i.label} (${i.file})`)).toEqual([]);
  });

  test("back is always esc, and esc is always back", () => {
    const items = menuItems();
    const wrongKey = items.filter((i) => i.label.startsWith("Back") && i.key !== "esc");
    expect(wrongKey.map((i) => `${i.key} ${i.label} (${i.file})`)).toEqual([]);
    const wrongLabel = items.filter((i) => i.key === "esc" && !i.label.startsWith("Back"));
    expect(wrongLabel.map((i) => `${i.key} ${i.label} (${i.file})`)).toEqual([]);
  });
});
