import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { mainCommand } from "../src/cli/index.ts";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

describe("README operator contract", () => {
  test("documents every live top-level command", () => {
    const commandNames = Object.keys(mainCommand.subCommands ?? {});
    for (const name of commandNames) {
      expect(readme, `missing phantombot ${name}`).toContain(
        `phantombot ${name}`,
      );
    }
  });

  test("every documented phantombot command resolves in the dispatcher", () => {
    const commandNames = new Set(Object.keys(mainCommand.subCommands ?? {}));
    const examples = [
      ...[...readme.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(
        (match) => match[1],
      ),
      ...[...readme.matchAll(/`(phantombot [^`]+)`/g)].map(
        (match) => match[1],
      ),
    ].join("\n");
    const documented = [...examples.matchAll(/\bphantombot ([^\s`]+)/g)]
      .flatMap((match) => (match[1] ? [match[1]] : []))
      .filter((token) => /^[a-z][a-z-]*(?:\|[a-z][a-z-]*)*$/.test(token))
      .map((token) => token.split("|")[0])
      .filter((name): name is string => name !== undefined);
    expect(documented.length).toBeGreaterThan(0);
    for (const name of documented) {
      expect(commandNames.has(name), `unknown README command: ${name}`).toBe(
        true,
      );
    }
  });

  test("documents the current nightly, task, memory, and MCP surfaces", () => {
    for (const text of [
      "--date YYYY-MM-DD",
      "--max-dates N",
      "--no-compact",
      "task list|show|cancel|log|selftest",
      "memory backup",
      "memory restore",
      "--export <dir> --with-id",
      "--import <dir>",
      "mcp help|add|list|status|search|describe|call|login|remove|proxy",
      "workspace lock|unlock|status",
      "reply-mode text|voice|default",
    ]) {
      expect(readme, `missing current CLI surface: ${text}`).toContain(text);
    }
  });

  test("rejects retired operational guidance", () => {
    for (const obsolete of [
      "phantombot nightly [--resume]",
      "phantombot nightly --resume",
      "phantombot memory get memory/decisions.md",
      "Foreground Telegram listener",
      "SmartScreen does not flag",
      "currently grow unbounded",
      "runs the full test suite alongside the Linux/macOS builds",
      "Telegram is the only adapter today",
      "EnvironmentFile=-%h/.env",
      "source ~/.env",
    ]) {
      expect(readme, `obsolete README claim survived: ${obsolete}`).not.toContain(
        obsolete,
      );
    }
    expect(readme).not.toMatch(
      /memory\/(?:people|decisions|lessons|commitments|norms)\.md/,
    );
  });

  test("states the current channel, trust, CI, and embedding boundaries", () => {
    for (const text of [
      "PhantomChat, Telegram, both, or neither",
      "local ACP",
      "TOFU-admitted",
      "does **not** receive",
      "sends the plaintext being embedded",
      "Windows-relevant suites",
      "There is no macOS pull-request runner",
      "legacy import sources only",
    ]) {
      expect(readme, `missing boundary statement: ${text}`).toContain(text);
    }
  });
});
