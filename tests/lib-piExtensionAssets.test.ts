/**
 * Drift guard for the generated Pi-extension assets module.
 *
 * If someone edits pi-extension/capability-routing/ without running
 * `bun run gen:pi-extension`, the committed src/lib/piExtensionAssets.generated.ts
 * goes stale and the shipped binary would stamp out-of-date source. This test
 * re-reads the 5 source files from disk and asserts byte-equality with the
 * generated constants (and that the hash recomputes), failing CI on drift.
 */
// NOTE: keep FILES in sync with scripts/genPiExtensionAssets.ts.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PI_EXTENSION_ASSETS_HASH,
  PI_EXTENSION_FILES,
} from "../src/lib/piExtensionAssets.generated.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = join(REPO_ROOT, "pi-extension", "capability-routing");

const FILES = ["index.ts", "tools.ts", "spawnPi.ts", "README.md"];

function hashEntries(entries: Array<[string, string]>): string {
  const h = createHash("sha256");
  for (const [rel, content] of [...entries].sort((a, b) => a[0].localeCompare(b[0]))) {
    h.update(rel, "utf8");
    h.update("\0", "utf8");
    h.update(content, "utf8");
    h.update("\0", "utf8");
  }
  return h.digest("hex");
}

describe("piExtensionAssets.generated", () => {
  test("embedded files match the on-disk extension source (run gen:pi-extension if this fails)", () => {
    for (const rel of FILES) {
      const onDisk = readFileSync(join(EXT_DIR, rel), "utf8");
      expect(PI_EXTENSION_FILES[rel]).toBe(onDisk);
    }
    // No stray keys beyond the ones we embed.
    expect(Object.keys(PI_EXTENSION_FILES).sort()).toEqual([...FILES].sort());
  });

  test("recomputed hash matches PI_EXTENSION_ASSETS_HASH", () => {
    const entries: Array<[string, string]> = FILES.map((rel) => [
      rel,
      readFileSync(join(EXT_DIR, rel), "utf8"),
    ]);
    expect(hashEntries(entries)).toBe(PI_EXTENSION_ASSETS_HASH);
  });
});
