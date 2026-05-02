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
import { defaultServiceControl, type ServiceControl } from "../lib/systemd.ts";

export type HarnessId = "claude" | "pi";
export const SUPPORTED_HARNESSES: ReadonlyArray<HarnessId> = ["claude", "pi"];

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
 * Shared post-apply hook for the config-mutating TUIs.
 *
 * Two steps. Always: re-render the on-disk systemd unit if it's stale (a
 * pre-Phase-29 unit lacks `EnvironmentFile=` and silently swallows the
 * .env secrets the TUI just wrote). Then: if phantombot is running, offer
 * to restart it inline so the change takes effect.
 */
export async function maybePromptRestart(
  svc: ServiceControl,
): Promise<void> {
  await maybeUpgradeUnit(svc);
  if (!(await svc.isActive())) return;
  const restart = await p.confirm({
    message: "phantombot is currently running. Restart to apply changes?",
    initialValue: true,
  });
  if (p.isCancel(restart) || !restart) {
    p.note(
      "skipped — restart later with: systemctl --user restart phantombot",
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
 * Re-render the installed systemd unit if it's stale; print a one-line
 * notice when it happened (and surface the backup path so a hand-edit is
 * recoverable). Exposed so tests can verify the rewrite path without
 * going through the @clack confirm prompt in maybePromptRestart.
 */
export async function maybeUpgradeUnit(
  svc: ServiceControl,
): Promise<{ rerendered: boolean; backupPath?: string }> {
  const r = await svc.rerenderUnitIfStale();
  if (r.rerendered) {
    const note = r.backupPath
      ? `systemd unit upgraded to current template\nprevious contents saved to ${r.backupPath}`
      : "systemd unit upgraded to current template";
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
