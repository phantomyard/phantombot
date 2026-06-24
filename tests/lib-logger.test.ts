/**
 * Tests for the structured logger's secret-redaction choke-point.
 *
 * The logger is the single producer of log lines, so it is where
 * `redactForLog` has to run — otherwise a token echoed into a field is
 * written to disk verbatim. These tests lock in that every line is
 * redacted (msg + fields + nested objects) and stays valid JSON.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { log } from "../src/lib/logger.ts";

function captureStream(which: "stdout" | "stderr"): {
  lines: string[];
  restore: () => void;
} {
  const lines: string[] = [];
  const original = process[which].write;
  process[which].write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    lines,
    restore: () => {
      process[which].write = original;
    },
  };
}

let out: ReturnType<typeof captureStream>;
let err: ReturnType<typeof captureStream>;

beforeEach(() => {
  out = captureStream("stdout");
  err = captureStream("stderr");
});

afterEach(() => {
  out.restore();
  err.restore();
});

function lastLine(lines: string[]): Record<string, unknown> {
  const raw = lines.join("").trim().split("\n").pop()!;
  // Must still be parseable: redaction replacements are quote/backslash-free.
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("logger redaction", () => {
  test("redacts a token echoed into a field value (warn → stderr)", () => {
    log.warn("upstream failed", {
      error: "GET failed: token ghp_0123456789abcdefghijABCDEF leaked",
    });
    const line = lastLine(err.lines);
    expect(line.msg).toBe("upstream failed");
    expect(String(line.error)).not.toContain("ghp_0123456789abcdefghijABCDEF");
    expect(String(line.error)).toContain("[REDACTED]");
  });

  test("redacts a secret in the message itself (info → stdout)", () => {
    log.info("loaded TELEGRAM_BOT_TOKEN=secret-value-123 from env");
    const line = lastLine(out.lines);
    expect(String(line.msg)).not.toContain("secret-value-123");
    expect(String(line.msg)).toContain("[REDACTED]");
  });

  test("redacts a self-identifying token nested inside an object field", () => {
    // A context-free token (AWS access key id) is caught regardless of how it
    // is nested AND regardless of the key name — here the key (`account`) is
    // not credential-bearing, so it is the token shape itself that triggers
    // redaction, preserving the specific AWS sentinel.
    log.error("config dump", {
      env: { creds: { account: "AKIAIOSFODNN7EXAMPLE" } },
    });
    const raw = err.lines.join("");
    expect(raw).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(raw).toContain("[AWS_KEY_REDACTED]");
    // Still valid JSON after redaction.
    expect(() => lastLine(err.lines)).not.toThrow();
  });

  test("redacts a credential-bearing JSON field by its KEY name", () => {
    // The structured-logging shape the review flagged: the value is only
    // recognizable as a secret via its field name. After serialization it is
    // `"TELEGRAM_BOT_TOKEN":"secret-value-123"` — no free-text `=` for the
    // label rule to anchor on — so the sink must match the JSON key form.
    log.info("env", { TELEGRAM_BOT_TOKEN: "secret-value-123" });
    const line = lastLine(out.lines);
    expect(JSON.stringify(line)).not.toContain("secret-value-123");
    expect(line.TELEGRAM_BOT_TOKEN).toBe("[REDACTED]");
  });

  test("redacts a credential-bearing JSON field nested in an object", () => {
    log.error("config dump", {
      env: { TELEGRAM_BOT_TOKEN: "112233:AAExampleNestedSecretValue" },
    });
    const raw = err.lines.join("");
    expect(raw).not.toContain("112233:AAExampleNestedSecretValue");
    expect(raw).toContain('"TELEGRAM_BOT_TOKEN":"[REDACTED]"');
    expect(() => lastLine(err.lines)).not.toThrow();
  });

  test("leaves a clean line untouched and parseable", () => {
    log.info("started", { chatId: 42, persona: "default" });
    const line = lastLine(out.lines);
    expect(line.msg).toBe("started");
    expect(line.chatId).toBe(42);
    expect(line.persona).toBe("default");
  });
});
