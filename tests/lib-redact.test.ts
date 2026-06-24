/**
 * Unit tests for `redactForLog`.
 *
 * Regression coverage for the secret shapes the redactor is responsible for,
 * with emphasis on the serialized-JSON key/value form added after review of
 * #188 — a credential-bearing field name (`"TELEGRAM_BOT_TOKEN":"…"`) that the
 * free-text `NAME=value` rule cannot anchor on once quotes are in the way.
 */

import { describe, expect, test } from "bun:test";
import { redactForLog } from "../src/lib/redact.ts";

describe("redactForLog — self-identifying tokens", () => {
  test("GitHub token prefix", () => {
    expect(redactForLog("ghp_0123456789abcdefghijABCDEF")).toContain(
      "ghp_[REDACTED]",
    );
  });
  test("Bearer token", () => {
    const r = redactForLog("Authorization: Bearer abcdef.ghijkl.mnopqr123");
    expect(r).toContain("Bearer [REDACTED]");
    expect(r).not.toContain("abcdef.ghijkl.mnopqr123");
  });
  test("AWS access key id", () => {
    // Plain prose so the AWS-id rule fires in isolation; a credential-looking
    // prefix (`key=…`) or JSON key would instead route it through the generic
    // `[REDACTED]` sentinel — still redacted, just a different marker.
    expect(redactForLog("using AKIAIOSFODNN7EXAMPLE now")).toContain(
      "[AWS_KEY_REDACTED]",
    );
  });
  test("email", () => {
    expect(redactForLog("from alice@example.com")).toContain("[EMAIL_REDACTED]");
  });
});

describe("redactForLog — free-text NAME=value", () => {
  test("redacts a credential-bearing assignment", () => {
    const r = redactForLog("TELEGRAM_BOT_TOKEN=secret-value-123 loaded");
    expect(r).toBe("TELEGRAM_BOT_TOKEN=[REDACTED] loaded");
  });
});

describe("redactForLog — serialized JSON key/value", () => {
  test("redacts a string value under a credential-bearing key", () => {
    const line = JSON.stringify({ TELEGRAM_BOT_TOKEN: "secret-value-123" });
    const r = redactForLog(line);
    expect(r).not.toContain("secret-value-123");
    expect(r).toBe('{"TELEGRAM_BOT_TOKEN":"[REDACTED]"}');
    // Output is still valid JSON.
    expect(() => JSON.parse(r)).not.toThrow();
  });

  test("redacts lowercase / mixed-case credential keys", () => {
    const r = redactForLog(JSON.stringify({ api_key: "abc123", webhookUrl: "https://x/y" }));
    expect(r).not.toContain("abc123");
    expect(r).not.toContain("https://x/y");
    expect(JSON.parse(r)).toEqual({ api_key: "[REDACTED]", webhookUrl: "[REDACTED]" });
  });

  test("redacts a numeric secret value and keeps JSON valid", () => {
    const r = redactForLog(JSON.stringify({ SECRET_PIN: 123456 }));
    expect(r).toBe('{"SECRET_PIN":"[REDACTED]"}');
    expect(() => JSON.parse(r)).not.toThrow();
  });

  test("handles a value containing an escaped quote without over-consuming", () => {
    const obj = { PASSWORD: 'a"b', persona: "default" };
    const r = redactForLog(JSON.stringify(obj));
    expect(r).not.toContain('a\\"b');
    const parsed = JSON.parse(r) as Record<string, unknown>;
    expect(parsed.PASSWORD).toBe("[REDACTED]");
    // Adjacent non-secret field is untouched.
    expect(parsed.persona).toBe("default");
  });

  test("leaves non-credential keys alone", () => {
    const r = redactForLog(JSON.stringify({ persona: "default", chatId: 42 }));
    expect(JSON.parse(r)).toEqual({ persona: "default", chatId: 42 });
  });
});
