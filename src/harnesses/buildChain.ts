/**
 * Build the harness chain from config. Single source of truth — was
 * previously duplicated in src/cli/run.ts and src/cli/tick.ts and is
 * now imported from both. The "third place" risk surfaces every time
 * a new harness lands; this helper retires it.
 *
 * Harness ids:
 *   claude, codex  — the host's CLIs, configured by their owner.
 *   native         — the pi engine embedded in this binary, with phantombot's
 *                    `[harnesses.pi.routing]`.
 *   pi-host        — the host's own `pi`, configured by its owner.
 *   <instance id>  — `[harnesses.instances.<id>]` with `type = "native"` or
 *                    `"pi-host"` (a chain that uses the pi engine twice).
 * A legacy `pi` is mapped at read time (lib/harnessReconcile.ts); if one still
 * reaches here it is decided by that same function, never guessed.
 *
 * Unknown harness ids are logged to err and skipped — same lenient
 * shape the duplicated copies had. Returning [] from here is treated
 * by the callers as "no harnesses configured" → exit 2 with a hint.
 */

import { type Config } from "../config.ts";
import type { WriteSink } from "../lib/io.ts";
import { piEngineFor } from "../lib/harnessReconcile.ts";
import { ENV_PI_API_KEY } from "../lib/piRouting.ts";
import { ClaudeHarness } from "./claude.ts";
import { PiHarness } from "./pi.ts";
import { CodexHarness } from "./codex.ts";
import type { Harness } from "./types.ts";

export function piInstanceSecretName(id: string): string {
  return `PHANTOMBOT_PI_API_KEY_${id.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;
}

/**
 * The vault key a chain id's EMBEDDED engine reads its provider key from, or
 * undefined when the id does not run native (claude, codex, pi-host, unknown).
 * A named instance reads its own suffixed key — the Brain flow persists a
 * native→native chain as `pi-primary` / `pi-fallback` — and the unnamed slot
 * reads `PHANTOMBOT_PI_API_KEY`. Same resolution `buildHarness` uses, so the
 * Vault screen can never expect a different key than the turn reads.
 */
export function nativeApiKeyNameFor(config: Config, id: string): string | undefined {
  if (piEngineFor(config.harnesses, id) !== "native") return undefined;
  return config.harnesses.instances?.[id] ? piInstanceSecretName(id) : ENV_PI_API_KEY;
}

export function harnessChainIds(config: Config, persona?: string): string[] {
  if (persona) {
    const override = config.harnesses.personas?.[persona]?.chain;
    if (override && override.length > 0) return override;
  }
  return config.harnesses.chain;
}

/**
 * Build ONE harness for a chain id, or undefined when the id is unknown. Shared
 * by the chain builder and the brain probe so a probed harness is constructed
 * exactly like the one a real turn runs.
 */
export function buildHarness(config: Config, id: string): Harness | undefined {
  if (id === "claude") return new ClaudeHarness(config.harnesses.claude);
  if (id === "codex") {
    return new CodexHarness(config.harnesses.codex ?? { bin: "codex", model: "" });
  }
  const engine = piEngineFor(config.harnesses, id);
  if (!engine) return undefined;
  const instance = config.harnesses.instances?.[id];
  const slot = instance ?? config.harnesses.pi;
  return new PiHarness({
    bin: slot.bin,
    routing: slot.routing,
    id,
    mode: engine === "native" ? "native" : "host",
    ...(instance ? { apiKeyEnv: piInstanceSecretName(id) } : {}),
  });
}

export function buildHarnessChain(
  config: Config,
  err: WriteSink,
  persona?: string,
): Harness[] {
  const out: Harness[] = [];
  for (const id of harnessChainIds(config, persona)) {
    const harness = buildHarness(config, id);
    if (harness) {
      out.push(harness);
    } else {
      err.write(`warning: unknown harness '${id}', skipping\n`);
    }
  }
  return out;
}
