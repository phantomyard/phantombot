/**
 * `phantombot harness` — interactive TUI to set the harness chain
 * (primary → fallback). Detects which binaries are on PATH and warns
 * about the ones that aren't.
 */

import { defineCommand } from "citty";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import * as p from "@clack/prompts";

import { type Config, loadConfig } from "../config.ts";
import { setIn, updateConfigToml } from "../lib/configWriter.ts";
import {
  defaultServiceControl,
  restartCommand,
  type ServiceControl,
} from "../lib/platform.ts";

export type HarnessId = "claude" | "pi" | "gemini";
export const SUPPORTED_HARNESSES: ReadonlyArray<HarnessId> = [
  "claude",
  "pi",
  "gemini",
];

export async function whichBinary(bin: string): Promise<string | undefined> {
  if (bin.startsWith("/")) {
    try {
      await access(bin, constants.X_OK);
      return bin;
    } catch {
      return undefined;
    }
  }
  const path = process.env.PATH ?? "";
  for (const dir of path.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

export async function detectAvailability(
  config: Config,
): Promise<Record<HarnessId, string | undefined>> {
  return {
    claude: await whichBinary(config.harnesses.claude.bin),
    pi: await whichBinary(config.harnesses.pi.bin),
    gemini: await whichBinary(config.harnesses.gemini.bin),
  };
}

export async function applyHarnessChain(
  configPath: string,
  chain: readonly HarnessId[],
): Promise<void> {
  await updateConfigToml(configPath, (toml) => {
    setIn(toml, ["harnesses", "chain"], [...chain]);
  });
}

interface RunInput {
  config?: Config;
  serviceControl?: ServiceControl;
}

export async function runHarness(input: RunInput = {}): Promise<number> {
  const config = input.config ?? (await loadConfig());
  const availability = await detectAvailability(config);
  const svc = input.serviceControl ?? defaultServiceControl();

  p.intro("Configure the harness chain");

  p.note(
    SUPPORTED_HARNESSES.map(
      (id) => `  ${availability[id] ? "[ok]  " : "[NOT FOUND]"} ${id}: ${availability[id] ?? config.harnesses[id].bin}`,
    ).join("\n"),
    "Detected harnesses",
  );

  const hasAnyHarness = Object.values(availability).some((path) => path !== undefined);
  if (!hasAnyHarness) {
    p.note(
      "No supported harness (claude, pi, gemini) was found on your PATH.\n" +
      "You will need to install at least one of them before the agent can think.\n" +
      "We will continue the setup anyway so your configuration is ready.",
      "Warning: No Harness Found",
    );
  }

  const primary = await p.select<HarnessId>({
    message: "Primary harness",
    options: SUPPORTED_HARNESSES.map((id) => ({
      value: id,
      label: id,
      hint: availability[id] ? availability[id] : "not on PATH (will fail)",
    })),
    initialValue:
      (config.harnesses.chain[0] as HarnessId) ?? SUPPORTED_HARNESSES[0],
  });
  if (p.isCancel(primary)) {
    p.cancel("cancelled");
    return 1;
  }

  const fallbackOptions: Array<{
    value: HarnessId | "none";
    label: string;
    hint?: string;
  }> = [
    { value: "none", label: "(none)", hint: "no fallback if primary fails" },
    ...SUPPORTED_HARNESSES.filter((id) => id !== primary).map((id) => ({
      value: id,
      label: id,
      hint: availability[id] ?? "not on PATH",
    })),
  ];

  const fallbackPick = await p.select<HarnessId | "none">({
    message: "Fallback harness",
    options: fallbackOptions,
    initialValue: (config.harnesses.chain[1] as HarnessId | undefined) ?? "none",
  });
  if (p.isCancel(fallbackPick)) {
    p.cancel("cancelled");
    return 1;
  }

  const chain: HarnessId[] = [primary as HarnessId];
  if (fallbackPick !== "none") chain.push(fallbackPick as HarnessId);

  await applyHarnessChain(config.configPath, chain);
  p.note(
    `harness chain: ${chain.join(" → ")}\nsaved to ${config.configPath}`,
    "Saved",
  );

  await maybePromptRestart(svc);

  p.outro("done");
  return 0;
}

/**
 * A confirm prompt: returns true to proceed, false to skip. Default
 * wraps `@clack/prompts` confirm; tests inject a stub so they can drive
 * `maybePromptRestart` end-to-end without a real TTY.
 */
export type ConfirmFn = (message: string) => Promise<boolean>;

const defaultConfirm: ConfirmFn = async (message) => {
  const r = await p.confirm({ message, initialValue: true });
  return !p.isCancel(r) && r === true;
};

/**
 * Shared post-apply hook for the config-mutating TUIs.
 *
 * Two steps. Always: re-render the on-disk service-manager unit if it's
 * stale (a pre-Phase-29 systemd unit lacks `EnvironmentFile=` and
 * silently swallows the .env secrets the TUI just wrote; the launchd
 * plist has analogous templating). Then: if phantombot is running, offer
 * to restart it inline so the change takes effect.
 *
 * `confirm` is parameterized so tests can drive the full ordering
 * (rerender → confirm → restart) without going through @clack's
 * non-TTY-friendly prompt.
 */
export async function maybePromptRestart(
  svc: ServiceControl,
  confirm: ConfirmFn = defaultConfirm,
): Promise<void> {
  await maybeUpgradeUnit(svc);
  if (!(await svc.isActive())) return;
  const proceed = await confirm(
    "phantombot is currently running. Restart to apply changes?",
  );
  if (!proceed) {
    p.note(
      `skipped — restart later with: ${restartCommand()}`,
      "Restart",
    );
    return;
  }
  const r = await svc.restart();
  p.note(
    r.ok ? "restarted" : `restart failed: ${r.stderr ?? "unknown"}`,
    "Restart",
  );
}

/**
 * Re-render the installed service-manager unit if it's stale; print a
 * one-line notice when it happened (and surface the backup path so a
 * hand-edit is recoverable). Exposed so tests can verify the rewrite
 * path without going through the @clack confirm prompt in
 * maybePromptRestart.
 */
export async function maybeUpgradeUnit(
  svc: ServiceControl,
): Promise<{ rerendered: boolean; backupPath?: string }> {
  const r = await svc.rerenderUnitIfStale();
  if (r.rerendered) {
    const note = r.backupPath
      ? `service-manager unit upgraded to current template\nprevious contents saved to ${r.backupPath}`
      : "service-manager unit upgraded to current template";
    p.note(note, "Unit");
  }
  return r;
}

export default defineCommand({
  meta: {
    name: "harness",
    description: "Set the harness chain (primary → fallback). Detects which binaries are on PATH.",
  },
  async run() {
    const code = await runHarness();
    process.exitCode = code;
  },
});
