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
// Contributor-facing pages are not public documentation: AGENTS.md and the
// invariants it indexes describe internals — and name the regressions to
// watch for — in words the public docs must never use.
const contributorDocs =
  /^(?:AGENTS\.md|docs\/contributing\/(?:invariants\/|repo-layout\.md))/;
const readme = pages.get("README.md") ?? "";
const publicDocs = [...pages]
  .filter(([path]) => !contributorDocs.test(path))
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

  test("the security overview states what an unscreened request does (issue #663)", async () => {
    // The perimeter's user-facing contract. Each claim is checked against
    // the code it describes, so the README cannot drift back to the
    // fail-open wording while the screener holds.
    const security = readme.replace(/\s+/g, " ");
    const screenSource = readFileSync(
      resolve(root, "src/orchestrator/screen.ts"),
      "utf8",
    );
    const notifyLine = "I held an untrusted request because I could not screen it";
    expect(screenSource).toContain(notifyLine);
    expect(security).toContain(notifyLine);
    expect(security).toContain("no threat score");
    expect(security).toContain("the request does not run");
    expect(security).toContain("cancels it");

    // The removed opt-out: documented as gone, and gone from the settings.
    expect(security).toMatch(/`\[jev\.judge\] fail_closed` key was removed/);
    const configSource = readFileSync(resolve(root, "src/config.ts"), "utf8");
    expect(configSource).not.toMatch(/failClosed\??:/);

    // The log line operators are pointed at exists under that name.
    expect(security).toContain("`screen: judge call`");
    expect(screenSource).toContain('"screen: judge call"');
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

describe("contributor invariants index", () => {
  const index = pages.get("AGENTS.md") ?? "";
  const INVARIANTS = "docs/contributing/invariants/";
  const areaPages = [...pages].filter(
    ([path]) => path.startsWith(INVARIANTS) && !path.endsWith("/README.md"),
  );

  test("every invariant is filed once and indexed once, with the same number, file and title", () => {
    const indexed = new Map<number, string>();
    for (const m of index.matchAll(
      /^- \[(\d+)\]\(docs\/contributing\/invariants\/([a-z-]+\.md)#inv-(\d+)\) (.+)$/gm,
    )) {
      const n = Number(m[1]);
      expect(m[3], `index entry ${n} links to anchor inv-${m[3]}`).toBe(m[1]);
      expect(indexed.has(n), `invariant ${n} is indexed twice`).toBe(false);
      indexed.set(n, `${m[2]}: ${m[4]}`);
    }
    const filed = new Map<number, string>();
    for (const [path, body] of areaPages) {
      const file = path.slice(INVARIANTS.length);
      const anchored = [...body.matchAll(/^<a id="inv-(\d+)"><\/a>\n### (\d+)\. (.+)$/gm)];
      expect(
        anchored.length,
        `${path}: every numbered heading needs an <a id="inv-N"> anchor`,
      ).toBe([...body.matchAll(/^### \d+\. /gm)].length);
      for (const m of anchored) {
        const n = Number(m[1]);
        expect(m[2], `${path}: anchor inv-${n} sits on invariant ${m[2]}`).toBe(m[1]);
        expect(filed.has(n), `invariant ${n} is filed twice`).toBe(false);
        filed.set(n, `${file}: ${m[3]}`);
      }
    }
    expect(filed.size).toBeGreaterThan(0);
    const byNumber = (a: number, b: number) => a - b;
    expect([...indexed.keys()].sort(byNumber)).toEqual([...filed.keys()].sort(byNumber));
    for (const [n, entry] of filed) expect(indexed.get(n), `index entry for ${n}`).toBe(entry);
  });

  test("every #inv-N link lands on an anchor in the page it names", () => {
    for (const [page, body] of pages) {
      for (const m of body.matchAll(/\]\(([^)#\s]*)#(inv-\d+)\)/g)) {
        const target = m[1] ? resolve(root, dirname(page), m[1]) : resolve(root, page);
        expect(
          readFileSync(target, "utf8").includes(`<a id="${m[2]}"></a>`),
          `${page} links to missing ${m[1]}#${m[2]}`,
        ).toBe(true);
      }
    }
  });

  test("every invariant cited by number exists", () => {
    const known = new Set([...index.matchAll(/^- \[(\d+)\]\(/gm)].map((m) => Number(m[1])));
    const cite = (where: string, text: string, pattern: RegExp) => {
      for (const m of text.matchAll(pattern)) {
        expect(known.has(Number(m[1])), `${where} cites unknown invariant ${m[1]}`).toBe(true);
      }
    };
    for (const [page, body] of pages) {
      if (page === "AGENTS.md" || page.startsWith("docs/contributing/")) {
        cite(page, body, /\b[Ii]nvariants? (\d+)\b/g);
      }
    }
    for (const dir of ["src", "tests"]) {
      for (const path of new Bun.Glob(`${dir}/**/*.{ts,tsx}`).scanSync({ cwd: root })) {
        cite(path, readFileSync(resolve(root, path), "utf8"), /\bAGENTS(?:\.md)? invariants? (\d+)\b/g);
      }
    }
  });

  test("the AGENTS.md path map names paths that exist", () => {
    const rows = [
      ...index.matchAll(/^\| (.+) \| \[[^\]]+\]\(docs\/contributing\/invariants\/[a-z-]+\.md\) \|$/gm),
    ];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      for (const span of row[1]!.matchAll(/`([^`]+)`/g)) {
        const path = span[1]!;
        const found = /[*{]/.test(path)
          ? [...new Bun.Glob(path).scanSync({ cwd: root })].length > 0
          : existsSync(resolve(root, path));
        expect(found, `AGENTS.md path map names missing ${path}`).toBe(true);
      }
    }
  });
});
