/**
 * Static guards for the Windows installer.
 *
 * install.ps1 only ever runs on Windows, so the Linux suite can't execute it —
 * but two of the ways it broke in PR #539 are visible in the bytes, and both
 * made the script unrunnable on a fresh Windows box (Windows PowerShell 5.1):
 *
 *  1. `[switch]$DryRun` AND `[switch]$dryrun` — PowerShell identifiers are
 *     case-insensitive, so that is a DuplicateFormalParameter parse error and
 *     nothing in the script ever runs.
 *  2. No UTF-8 BOM — 5.1 decodes a BOM-less .ps1 as the ANSI codepage, so the
 *     banner's box-drawing glyphs became mojibake mid-string and the file
 *     failed to parse.
 *
 * CI also parses and dry-runs the script on windows-latest (see ci.yml); these
 * tests are the fast local mirror so the failure shows up before a push.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PATH = join(import.meta.dir, "..", "install.ps1");

describe("install.ps1", () => {
  test("starts with a UTF-8 BOM so PowerShell 5.1 decodes it as UTF-8", () => {
    const bytes = readFileSync(PATH);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  test("declares no two parameters that differ only in case", () => {
    const text = readFileSync(PATH, "utf8");
    const block = /^param\(([\s\S]*?)^\)/m.exec(text);
    expect(block).not.toBeNull();
    const names = [...block![1]!.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map(
      (m) => m[1]!.toLowerCase(),
    );
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });

  test("forces UTF-8 console output before drawing the banner", () => {
    const text = readFileSync(PATH, "utf8");
    const encodingAt = text.indexOf("[Console]::OutputEncoding");
    const bannerAt = text.indexOf("$phantomLines");
    expect(encodingAt).toBeGreaterThan(-1);
    expect(encodingAt).toBeLessThan(bannerAt);
  });

  test("interpolates \\$bold with braces so it can't swallow the next word", () => {
    const text = readFileSync(PATH, "utf8");
    // "$boldLearns ..." parses as a variable named `boldLearns`, which under
    // Set-StrictMode is a hard runtime error, not a cosmetic one.
    expect(text).not.toMatch(/\$(bold|dim|reset|c\d+)[A-Za-z]/);
  });
});
