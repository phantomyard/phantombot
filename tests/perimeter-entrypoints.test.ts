/**
 * Perimeter guard: every place that starts a turn must say how it is gated.
 *
 * The threat judge only runs when the caller of `runTurn` hands it a
 * `screen`. That makes "forgot to pass one" a silent hole — the turn is
 * stamped untrusted, looks screened in review, and reaches the harness
 * unjudged. The scheduled-task path sat like that from the day the judge
 * shipped, and every poller wake-up rode through it.
 *
 * So this test reads the SOURCE: each `runTurn({ … })` call site must, inside
 * its own argument object, either pass a `screen` or state `trusted`. A new
 * entry point that does neither fails here, by name, before it ships.
 *
 * It cannot prove a `trusted: true` is deserved — that is a review question,
 * and the list of who may claim it is closed below so a new claimant has to
 * edit this file and be seen doing it.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * Index just past the string literal or comment starting at `i`, or `i`
 * itself when none starts there. Lets the brace scan ignore a `{` or `}` that
 * is text rather than structure. A template literal is skipped whole —
 * nested backticks inside a `${ … }` are not followed, and such a call site
 * fails loudly (unbalanced) rather than passing.
 */
function skipTrivia(text: string, i: number): number {
  const c = text[i];
  if (c === "/" && text[i + 1] === "/") {
    const end = text.indexOf("\n", i);
    return end === -1 ? text.length : end;
  }
  if (c === "/" && text[i + 1] === "*") {
    const end = text.indexOf("*/", i + 2);
    return end === -1 ? text.length : end + 2;
  }
  if (c === '"' || c === "'" || c === "`") {
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === "\\") j++;
      else if (text[j] === c) return j + 1;
    }
    return text.length;
  }
  return i;
}

/**
 * The TOP-LEVEL text of the balanced `{ … }` argument object starting at
 * `open`: strings and comments dropped, and everything nested inside a
 * further `{}`, `()` or `[]` dropped too. What is left is the object's own
 * keys, so a `screen` belonging to some nested literal — or sitting in a
 * string — cannot stand in for the call site's own.
 */
function ownKeysAt(text: string, open: number): string {
  let depth = 0;
  let out = "";
  for (let i = open; i < text.length; i++) {
    const next = skipTrivia(text, i);
    if (next !== i) {
      if (depth === 1) out += " ";
      i = next - 1;
      continue;
    }
    const c = text[i];
    if (c === "{" || c === "(" || c === "[") {
      depth++;
      if (depth === 1) out += c;
    } else if (c === "}" || c === ")" || c === "]") {
      depth--;
      if (depth === 0) return out + c;
    } else if (depth === 1) {
      out += c;
    }
  }
  throw new Error("unbalanced runTurn argument object");
}

interface CallSite {
  file: string;
  /** Own keys of the inline argument object; null when a variable is passed. */
  args: string | null;
}

function runTurnCallSites(): CallSite[] {
  const sites: CallSite[] = [];
  for (const path of sourceFiles(SRC)) {
    const text = readFileSync(path, "utf8");
    // Only files that import the orchestrator's runTurn: the TUI has an
    // unrelated local function of the same name.
    if (!/import\s*\{[^}]*\brunTurn\b[^}]*\}\s*from\s*["'][^"']*orchestrator\/turn\.ts["']/.test(text)) {
      continue;
    }
    const file = relative(SRC, path);
    const re = /\brunTurn\(\s*/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const at = m.index + m[0].length;
      // A variable argument is built somewhere the scan cannot follow, so it
      // proves nothing here — it is only tolerated on the closed list below.
      sites.push({ file, args: text[at] === "{" ? ownKeysAt(text, at) : null });
    }
  }
  return sites;
}

const passesScreen = (args: string | null): boolean =>
  args !== null && /(^|[\s,{])screen\s*[:,}]/.test(args);
const statesTrusted = (args: string | null): boolean =>
  args !== null && /(^|[\s,{])trusted\s*[:,}]/.test(args);

/**
 * Entry points that run with NO screener because the turn is trusted by
 * construction. Closed list — adding one is a perimeter decision.
 */
const TRUSTED_WITHOUT_SCREEN = new Set([
  // Runtime-authored nightly memory cycle (a system job; see AGENTS.md).
  "cli/nightly.ts",
  // A human at a local TTY in the account that owns the persona.
  "tui/chatSession.ts",
  // Editor connectors (ACP): the local-CLI entry point is the trust origin.
  "connectors/acp/turnBridge.ts",
  // Emoji reactions: both callers drop non-principal reactions first.
  "channels/core/reactions.ts",
]);

/**
 * Call sites allowed to hand `runTurn` a prebuilt variable instead of an
 * inline object. The scan cannot read their keys, so each must ALSO be on the
 * trusted list — an entry point that needs a screen has to show it inline.
 */
const VARIABLE_ARGUMENT = new Set(["connectors/acp/turnBridge.ts"]);

describe("security perimeter — every runTurn entry point is gated", () => {
  const sites = runTurnCallSites();

  test("the scan finds the entry points (a broken scan must not pass vacuously)", () => {
    const files = new Set(sites.map((s) => s.file));
    for (const expected of [
      "cli/ask.ts",
      "cli/tick.ts",
      "cli/nightly.ts",
      "channels/core/engine.ts",
      "channels/phantomchat/server.ts",
      "engine/engine.ts",
      "tui/chatSession.ts",
      "connectors/acp/turnBridge.ts",
    ]) {
      expect(files.has(expected)).toBe(true);
    }
  });

  test("each call site passes a screen, or is on the closed trusted list", () => {
    const ungated = sites
      .filter((s) => !passesScreen(s.args))
      .filter(
        (s) =>
          !(
            TRUSTED_WITHOUT_SCREEN.has(s.file) &&
            (statesTrusted(s.args) ||
              (s.args === null && VARIABLE_ARGUMENT.has(s.file)))
          ),
      )
      .map((s) => s.file);
    expect(ungated).toEqual([]);
  });

  test("the untrusted-only entry points never state `trusted` at all", () => {
    // `ask` and scheduled wakes have no principal; a `trusted` key appearing
    // in either is a bypass, whatever value it is given.
    for (const file of ["cli/ask.ts", "cli/tick.ts"]) {
      const own = sites.filter((s) => s.file === file);
      expect(own.length).toBeGreaterThan(0);
      for (const s of own) {
        expect(passesScreen(s.args)).toBe(true);
        expect(statesTrusted(s.args)).toBe(false);
      }
    }
  });

  test("the trusted list holds no stale entries", () => {
    const files = new Set(sites.map((s) => s.file));
    for (const f of TRUSTED_WITHOUT_SCREEN) expect(files.has(f)).toBe(true);
  });

  test("a variable argument is only accepted from the closed list", () => {
    const variable = new Set(
      sites.filter((s) => s.args === null).map((s) => s.file),
    );
    expect([...variable].sort()).toEqual([...VARIABLE_ARGUMENT].sort());
    for (const f of VARIABLE_ARGUMENT) {
      expect(TRUSTED_WITHOUT_SCREEN.has(f)).toBe(true);
    }
  });

  test("the scan reads own keys only — nested or quoted `screen` proves nothing", () => {
    const own = (code: string) => ownKeysAt(code, code.indexOf("{"));
    expect(passesScreen(own("f({ a: 1, screen: s })"))).toBe(true);
    expect(passesScreen(own("f({ a: 1, screen })"))).toBe(true);
    expect(passesScreen(own("f({ a: { screen: s } })"))).toBe(false);
    expect(passesScreen(own("f({ a: g({ screen: s }) })"))).toBe(false);
    expect(passesScreen(own('f({ a: "} screen: x" })'))).toBe(false);
    expect(passesScreen(own("f({ a: 1 /* screen: s */ })"))).toBe(false);
    expect(passesScreen(own("f({ a: 1 }); g({ screen: s })"))).toBe(false);
    expect(passesScreen(null)).toBe(false);
  });
});
