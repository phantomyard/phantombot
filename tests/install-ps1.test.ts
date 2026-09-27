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
 * The BOM has a second consequence, which is what these tests were extended for:
 * `Invoke-WebRequest` hands the BOM through to `iex` as a leading U+FEFF
 * character, and 5.1 then cannot parse the script at all - the `<#` opener is
 * lost, so the help text is parsed as code (`Unexpected token 'Clears' ...`) and
 * `[CmdletBinding()]` is no longer the first statement. No layout of the script
 * survives that (verified on 5.1.26100), so the documented one-liner must strip
 * the BOM itself - hence the assertions on README.md, www/index.html and the
 * script's own usage line below.
 *
 * CI also parses and dry-runs the script on windows-latest (see ci.yml); these
 * tests are the fast local mirror so the failure shows up before a push.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PATH = join(ROOT, "install.ps1");

// The one and only Windows install command we publish. Any doc that shows a way
// to run install.ps1 from the network must show exactly this.
const ONE_LINER =
  "iex ((iwr -useb https://raw.githubusercontent.com/phantomyard/phantombot/main/install.ps1)" +
  ".Content.TrimStart([char]0xFEFF))";

const DOCS = ["README.md", "www/index.html", "install.ps1"];

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

describe("the published one-liner", () => {
  test.each(DOCS)("%s publishes the BOM-stripping one-liner", (doc) => {
    const text = readFileSync(join(ROOT, doc), "utf8");
    expect(text).toContain(ONE_LINER);
  });

  test.each(DOCS)("%s never pipes the raw download into iex", (doc) => {
    const text = readFileSync(join(ROOT, doc), "utf8");
    // `iwr ... install.ps1 | iex` hands the BOM straight to the parser, which is
    // the exact command that failed for a user on a fresh Windows box.
    const piped = /install\.ps1(?![^\n]*TrimStart)[^\n]*\|\s*iex/i;
    expect(text).not.toMatch(piped);
  });

  test("every network invocation in the docs strips the BOM first", () => {
    for (const doc of DOCS) {
      const text = readFileSync(join(ROOT, doc), "utf8");
      for (const line of text.split("\n")) {
        if (!/iex/.test(line)) continue;
        if (!/raw\.githubusercontent\.com.*install\.ps1/.test(line)) continue;
        expect(line).toContain("TrimStart([char]0xFEFF)");
      }
    }
  });
});
