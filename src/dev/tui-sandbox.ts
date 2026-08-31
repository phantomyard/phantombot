/**
 * Sandboxed TUI launcher for local iteration.
 *
 * Boots the REAL TUI (`tui/index.tsx`) against an isolated config/data/state
 * root under `<repo>/.sandbox/`, so the configure screens and the new-persona
 * wizard can be changed and exercised without touching any live persona on
 * this host and without waiting on CI.
 *
 * Isolation is done entirely with the precedence the config loader already
 * honours:
 *   - XDG_CONFIG_HOME / XDG_DATA_HOME / XDG_STATE_HOME point into .sandbox/
 *     (config.toml, personas, memory.sqlite, memory-index, tasks, logs, state)
 *   - PHANTOMBOT_CONFIG pins the global config.toml
 *   - PHANTOMBOT_PERSONAS_DIR pins the personas root
 *
 * The bare-TUI path (`bun src/dev/tui-sandbox.ts` with a TTY) starts ONLY the
 * TUI — no Telegram poller, no p2p, no nightly, no systemd reconciliation —
 * so a sandbox run cannot collide with a live persona's surfaces.
 *
 * The guard below refuses to boot unless every isolated root actually
 * resolves inside .sandbox/, so a missed env var can never silently point the
 * TUI at the host's real data.
 */

import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// <repo>/src/dev/tui-sandbox.ts → three levels up to the repo root.
const repoRoot = resolve(
  join(fileURLToPath(import.meta.url), "..", "..", ".."),
);
const sandboxRoot = join(repoRoot, ".sandbox");

for (const dir of [
  join(sandboxRoot, "config"),
  join(sandboxRoot, "data"),
  join(sandboxRoot, "state"),
]) {
  mkdirSync(dir, { recursive: true });
}

process.env.XDG_CONFIG_HOME = join(sandboxRoot, "config");
process.env.XDG_DATA_HOME = join(sandboxRoot, "data");
process.env.XDG_STATE_HOME = join(sandboxRoot, "state");
process.env.PHANTOMBOT_CONFIG = join(
  sandboxRoot,
  "config",
  "phantombot",
  "config.toml",
);
process.env.PHANTOMBOT_PERSONAS_DIR = join(
  sandboxRoot,
  "data",
  "phantombot",
  "personas",
);

function insideSandbox(p: string): boolean {
  return resolve(p).startsWith(sandboxRoot + "/");
}

const isolated = [
  process.env.XDG_CONFIG_HOME,
  process.env.XDG_DATA_HOME,
  process.env.XDG_STATE_HOME,
  process.env.PHANTOMBOT_CONFIG,
  process.env.PHANTOMBOT_PERSONAS_DIR,
] as string[];

if (!isolated.every(insideSandbox)) {
  console.error(
    "tui-sandbox: isolation guard failed — an XDG/PHANTOMBOT root did not " +
      "resolve inside .sandbox/. Refusing to boot so live data cannot be touched.",
  );
  process.exit(1);
}

// Everything below is the ordinary bare-TUI entry; with a TTY attached this is
// exactly `phantombot` (TUI), with no argv so bareInvocationMode() applies.
await import("../index.ts");
