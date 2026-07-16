/**
 * Embedded VS Code .vsix asset integrity tests.
 *
 * The .vsix is a binary zip whose bytes are NOT reproducible across builds
 * (zip timestamps/metadata vary), so — unlike the pi-extension hash check — we
 * deliberately do NOT assert byte-exact drift. Instead we assert the things
 * below, which catch ONE failure mode: bumping editors/vscode/package.json
 * without regenerating the embedded module.
 *
 * Be clear about the limit, because over-trusting these assertions shipped a
 * broken v1.1.204: they canNOT catch "edited editors/vscode/ and regenerated
 * nothing", since the version and the stale asset still agree and every check
 * here passes. Freshness is enforced structurally instead — the release
 * rebuilds the .vsix from source on every build and stamps it with the
 * phantombot release version (see scripts/genVscodeVsix.ts). These assertions
 * cover the checked-in dev asset, not the shipped one:
 *
 *   1. The embedded VSCODE_EXTENSION_VERSION matches editors/vscode/package.json.
 *   2. The embedded VSCODE_EXTENSION_ID matches publisher.name from that manifest.
 *   3. The base64 decodes to a real zip (PK magic) that carries the extension
 *      manifest and the bundled extension.js — i.e. a genuinely installable vsix.
 *
 * Regenerate with `bun run gen:vscode-vsix` if this fails after editing
 * editors/vscode/.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  VSCODE_EXTENSION_ID,
  VSCODE_EXTENSION_VERSION,
  VSCODE_VSIX_BASE64,
  VSCODE_VSIX_FILENAME,
} from "../src/lib/vscodeExtensionAsset.generated.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const EXT_PKG = JSON.parse(
  readFileSync(join(REPO_ROOT, "editors", "vscode", "package.json"), "utf8"),
) as { name: string; version: string; publisher: string };

describe("embedded vscode .vsix asset", () => {
  test("embedded version matches editors/vscode/package.json", () => {
    expect(VSCODE_EXTENSION_VERSION).toBe(EXT_PKG.version);
  });

  test("embedded id matches publisher.name from the manifest", () => {
    expect(VSCODE_EXTENSION_ID).toBe(`${EXT_PKG.publisher}.${EXT_PKG.name}`);
  });

  test("filename encodes name + version", () => {
    expect(VSCODE_VSIX_FILENAME).toBe(`${EXT_PKG.name}-${EXT_PKG.version}.vsix`);
  });

  test("base64 decodes to a non-trivial zip (PK magic)", () => {
    const bytes = Buffer.from(VSCODE_VSIX_BASE64, "base64");
    expect(bytes.length).toBeGreaterThan(1024);
    // ZIP local file header magic: 0x50 0x4B 0x03 0x04 ("PK\x03\x04").
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    expect(bytes[2]).toBe(0x03);
    expect(bytes[3]).toBe(0x04);
  });

  test("zip carries the manifest and the bundled extension.js", () => {
    // Entry names are stored as plain bytes in each local file header, so we can
    // assert presence without a zip library.
    const text = Buffer.from(VSCODE_VSIX_BASE64, "base64").toString("latin1");
    expect(text).toContain("extension.vsixmanifest");
    expect(text).toContain("extension/package.json");
    expect(text).toContain("extension/dist/extension.js");
  });
});
