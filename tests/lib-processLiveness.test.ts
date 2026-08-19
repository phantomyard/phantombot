import { describe, expect, test } from "bun:test";

import { parseWindowsStart } from "../src/lib/processLiveness.ts";

describe("parseWindowsStart", () => {
  test("parses a PowerShell round-trip ISO 8601 datetime", () => {
    const out = "2026-08-19T14:22:31.1234567+02:00\r\n";
    expect(parseWindowsStart(out)).toBe("2026-08-19T14:22:31.1234567+02:00");
  });

  test("parses a wmic CIM_DATETIME", () => {
    // yyyymmddhhmmss.uuuuuu+timezone
    const out = "20260819142231.123456+120\r\n";
    expect(parseWindowsStart(out)).toBe("20260819142231.123456+120");
  });

  test("parses a UTC wmic datetime with +0 offset", () => {
    const out = "20260819142231.123456+0\r\n";
    expect(parseWindowsStart(out)).toBe("20260819142231.123456+0");
  });

  test("skips the wmic header row and returns the value", () => {
    // wmic output includes a "CreationDate" header before the actual value
    const out = "CreationDate\r\n20260819142231.123456+120\r\n\r\n";
    expect(parseWindowsStart(out)).toBe("20260819142231.123456+120");
  });

  test("returns the FIRST matching line when multiple are present", () => {
    const out =
      "2026-08-19T14:22:31.1234567+02:00\r\n2026-08-19T14:25:00.0000000+02:00\r\n";
    expect(parseWindowsStart(out)).toBe("2026-08-19T14:22:31.1234567+02:00");
  });

  test("returns null for an empty string (process exited before probe)", () => {
    expect(parseWindowsStart("")).toBeNull();
    expect(parseWindowsStart("   ")).toBeNull();
    expect(parseWindowsStart("\r\n\r\n")).toBeNull();
  });

  test("returns null for the bare header with no data row", () => {
    expect(parseWindowsStart("CreationDate\r\n\r\n")).toBeNull();
  });

  test("returns null for a localized error message", () => {
    // wmic may emit error text in the system locale
    expect(parseWindowsStart("ERROR - Description = Not found")).toBeNull();
  });

  test("returns null for a partial datetime (not a valid identity)", () => {
    // A partial match would be an identity that changes on its own — rejected
    expect(parseWindowsStart("2026-08-19")).toBeNull();
    expect(parseWindowsStart("14:22:31")).toBeNull();
    expect(parseWindowsStart("20260819142231")).toBeNull(); // missing fractional + tz
  });

  test("returns null for a PowerShell error stream", () => {
    // PowerShell may emit errors on stdout in some configurations
    expect(
      parseWindowsStart(
        "Get-CimInstance : Cannot find the process\r\n    + CategoryInfo : ...",
      ),
    ).toBeNull();
  });

  test("handles Unix newlines (LF) as well as Windows (CRLF)", () => {
    expect(parseWindowsStart("2026-08-19T14:22:31.1234567+02:00\n")).toBe(
      "2026-08-19T14:22:31.1234567+02:00",
    );
  });

  test("trims whitespace around the value", () => {
    expect(parseWindowsStart("  2026-08-19T14:22:31.1234567+02:00  \r\n")).toBe(
      "2026-08-19T14:22:31.1234567+02:00",
    );
  });
});
