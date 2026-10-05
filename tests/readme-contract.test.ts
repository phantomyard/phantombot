import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { mainCommand } from "../src/cli/index.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const markdownPaths = [
  "README.md",
  "AGENTS.md",
  ...new Bun.Glob("docs/**/*.md").scanSync({ cwd: root }),
];
const pages = new Map(
  markdownPaths.map((path) => [path, readFileSync(resolve(root, path), "utf8")]),
);
const readme = pages.get("README.md") ?? "";
const publicDocs = [...pages]
  .filter(([path]) => path !== "AGENTS.md")
  .map(([, body]) => body)
  .join("\n");

describe("public documentation contract", () => {
  test("keeps the repository front door human-sized", () => {
    const prose = readme
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/<[^>]+>/g, " ");
    const words = prose.trim().split(/\s+/).filter(Boolean);
    expect(words.length).toBeLessThanOrEqual(2_500);
    expect(readme).toContain("docs/README.md");
    expect(readme).toContain("phantombot --help");
  });

  test("every documented top-level command resolves in the dispatcher", () => {
    const commandNames = new Set(Object.keys(mainCommand.subCommands ?? {}));
    const examples = [
      ...[...publicDocs.matchAll(/```([^\n]*)\n([\s\S]*?)```/g)]
        // Diagram fences (mermaid) are illustrations, not CLI examples —
        // their node labels would otherwise be validated as commands.
        .filter((match) => !/mermaid/.test(match[1] ?? ""))
        .map((match) => match[2]),
      ...[...publicDocs.matchAll(/`(phantombot [^`]+)`/g)].map(
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
      expect(commandNames.has(name), `unknown documented command: ${name}`).toBe(
        true,
      );
    }
  });

  test("all relative Markdown links resolve", () => {
    for (const [page, body] of pages) {
      for (const match of body.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        const target = match[1];
        if (!target || /^(?:https?:|mailto:|#)/.test(target)) continue;
        const path = target.split("#", 1)[0];
        if (!path) continue;
        expect(
          existsSync(resolve(root, dirname(page), decodeURIComponent(path))),
          `${page} links to missing ${target}`,
        ).toBe(true);
      }
    }
  });

  test("keeps temporary plans out of permanent documentation", () => {
    expect(existsSync(resolve(root, "docs/plans"))).toBe(false);
    for (const obsolete of [
      "src/repl/index.ts",
      "current shape is CLI only",
      "Telegram is the only adapter today",
      "memory/decisions.md",
    ]) {
      expect(publicDocs, `obsolete public guidance survived: ${obsolete}`).not.toContain(
        obsolete,
      );
    }
  });
});
