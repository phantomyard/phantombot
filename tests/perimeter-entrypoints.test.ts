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

/** The balanced `{ … }` argument object starting at `open`. */
function objectLiteralAt(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  throw new Error("unbalanced runTurn argument object");
}

/** Strip comments so prose mentioning `screen`/`trusted` proves nothing. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

interface CallSite {
  file: string;
  args: string;
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
      if (text[at] === "{") {
        sites.push({ file, args: stripComments(objectLiteralAt(text, at)) });
      } else {
        // Called with a variable: the object is built elsewhere in the file,
        // so the whole file has to carry the gate.
        sites.push({ file, args: stripComments(text) });
      }
    }
  }
  return sites;
}

const passesScreen = (args: string): boolean => /(^|[\s,{])screen\s*[:,}]/.test(args);
const statesTrusted = (args: string): boolean => /(^|[\s,{])trusted\s*[:,}]/.test(args);

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
        (s) => !(TRUSTED_WITHOUT_SCREEN.has(s.file) && statesTrusted(s.args)),
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
});
