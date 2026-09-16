/**
 * PR #572 propagation guard: `harness_thinking_timeout_s` must reach the
 * harness no matter which entry point started the turn. Every config-backed
 * request builder that forwards `harnessIdleTimeoutMs` as an idle timeout must
 * forward `harnessThinkingTimeoutMs` in the same object literal; otherwise
 * that path silently runs on the runner's 600s default.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

// Builders that deliberately do not take a thinking budget. The threat judge
// is a tool-less, single-shot classifier with a positional timeout signature.
const EXEMPT = new Set(["lib/threatJudge.ts", "config.ts"]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("thinking budget propagation", () => {
  test("every idleTimeoutMs: config.harnessIdleTimeoutMs builder also forwards harnessThinkingTimeoutMs", () => {
    const offenders: string[] = [];
    let builders = 0;
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file);
      if (EXEMPT.has(rel)) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/idleTimeoutMs:\s*[\w.]*harnessIdleTimeoutMs/.test(line)) return;
        builders++;
        const window = lines.slice(Math.max(0, i - 12), i + 12).join("\n");
        if (!/harnessThinkingTimeoutMs/.test(window)) {
          offenders.push(`${rel}:${i + 1}`);
        }
      });
    }
    expect(builders).toBeGreaterThanOrEqual(9);
    expect(offenders).toEqual([]);
  });
});
