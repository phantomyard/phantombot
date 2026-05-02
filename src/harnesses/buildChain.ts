/**
 * Build the harness chain from config. Single source of truth — was
 * previously duplicated in src/cli/run.ts and src/cli/tick.ts and is
 * now imported from both. The "third place" risk surfaces every time
 * a new harness lands; this helper retires it.
 *
 * Unknown harness ids are logged to err and skipped — same lenient
 * shape the duplicated copies had. Returning [] from here is treated
 * by the callers as "no harnesses configured" → exit 2 with a hint.
 */

import { type Config } from "../config.ts";
import type { WriteSink } from "../lib/io.ts";
import { ClaudeHarness } from "./claude.ts";
import { GeminiHarness } from "./gemini.ts";
import { PiHarness } from "./pi.ts";
import type { Harness } from "./types.ts";

export function buildHarnessChain(config: Config, err: WriteSink): Harness[] {
  const out: Harness[] = [];
  for (const id of config.harnesses.chain) {
    if (id === "claude") {
      out.push(new ClaudeHarness(config.harnesses.claude));
    } else if (id === "pi") {
      out.push(new PiHarness(config.harnesses.pi));
    } else if (id === "gemini") {
      out.push(new GeminiHarness(config.harnesses.gemini));
    } else {
      err.write(`warning: unknown harness '${id}', skipping\n`);
    }
  }
  return out;
}
