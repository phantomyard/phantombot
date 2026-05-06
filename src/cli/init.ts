import { execFile, execFileSync } from "node:child_process";
import { userInfo } from "node:os";

import { defineCommand } from "citty";
import * as p from "@clack/prompts";

import { type Config, loadConfig } from "../config.ts";
import { ensureUserSystemdEnv } from "../lib/systemd.ts";
import {
  detectAvailability,
  type HarnessId,
  runHarness,
} from "./harness.ts";
import { runInstall } from "./install.ts";
import { runPersona } from "./persona.ts";
import { runTelegram } from "./telegram.ts";

export interface InitFlowInput {
  config: Config;
  availability: Record<HarnessId, string | undefined>;
}

export interface InitFlowDeps {
  runHarness: (input: {
    config: Config;
    availability: Record<HarnessId, string | undefined>;
  }) => Promise<number>;
  runPersona: () => Promise<number>;
  runTelegram: () => Promise<number>;
}

/**
 * Pure orchestration of the three configuration wizards: harness → persona
 * → telegram. Short-circuits on the first non-zero exit. Extracted from the
 * interactive `run()` so the ordering and short-circuit behavior is testable
 * without a TTY. The install wizard runs after this in `run()` so it can be
 * gated on a separate user confirmation and a Linux-only linger pre-check.
 */
export async function runInitFlow(
  input: InitFlowInput,
  deps: InitFlowDeps,
): Promise<number> {
  const harnessCode = await deps.runHarness({
    config: input.config,
    availability: input.availability,
  });
  if (harnessCode !== 0) return harnessCode;

  const personaCode = await deps.runPersona();
  if (personaCode !== 0) return personaCode;

  const telegramCode = await deps.runTelegram();
  if (telegramCode !== 0) return telegramCode;

  return 0;
}

/**
 * Cheap "is this CLI installed and runnable?" probe. We deliberately use
 * `--version` (and not e.g. `<bin> hello`) so the probe doesn't trigger a
 * real LLM round-trip — three harnesses × a 15 s timeout each could mean
 * up to ~45 s of paid inference just to greet the user during install. A
 * `--version` exits in milliseconds, costs nothing, and tells us what we
 * actually want to know: is the binary on PATH and able to run.
 *
 * This does NOT detect "binary present but not authenticated" — that's a
 * harness-specific check (different for claude vs pi vs gemini) and is
 * deferred to a follow-up.
 */
async function probeHarness(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: 5000 }, (error, stdout) => {
      resolve(!error && stdout.trim().length > 0);
    });
  });
}

export default defineCommand({
  meta: {
    name: "init",
    description: "Launch the full Phantombot unified setup wizard.",
  },
  async run() {
    p.intro("Welcome to Phantombot");

    p.note(
      "This wizard will guide you through 4 quick steps to get your agent running:\n" +
      "  1. Pick your AI harness (claude, pi, or gemini)\n" +
      "  2. Create a persona (identity & memory)\n" +
      "  3. Connect to Telegram\n" +
      "  4. Install as a background service",
      "Setup Flow"
    );

    const ready = await p.confirm({
      message: "Ready to start?",
      initialValue: true,
    });

    if (p.isCancel(ready) || !ready) {
      p.cancel("Setup cancelled.");
      process.exitCode = 1;
      return;
    }

    const config = await loadConfig();

    const spinner = p.spinner();
    spinner.start("Probing installed AI harnesses to find a configured one...");

    // Check which ones are on PATH. Reused below by `runHarness` so we don't
    // walk PATH twice during the same wizard.
    const avail = await detectAvailability(config);

    const probeResults: Record<string, boolean> = {};
    for (const [id, bin] of Object.entries(avail)) {
      if (bin) {
        probeResults[id] = await probeHarness(bin);
      } else {
        probeResults[id] = false;
      }
    }

    spinner.stop("Probe complete.");

    const configured = Object.entries(probeResults)
      .filter(([, isReady]) => isReady)
      .map(([id]) => id);

    if (configured.length > 0) {
      p.note("Found configured AI harnesses: " + configured.join(", "), "Probe result");
    } else {
      p.note(
        "No AI harness responded to '--version'.\n" +
        "You might need to install one (claude, pi, or gemini) first, " +
        "but we can still set up the configuration now.",
        "Probe result"
      );
    }

    // 1-3: harness → persona → telegram, orchestrated by runInitFlow so
    // the ordering + short-circuit behavior can be tested without a TTY.
    const flowCode = await runInitFlow(
      { config, availability: avail },
      {
        runHarness: (input) => runHarness(input),
        runPersona,
        runTelegram,
      },
    );
    if (flowCode !== 0) {
      process.exitCode = flowCode;
      return;
    }

    // 4. Install
    // Use a step marker, not a second p.intro — clack renders one
    // open / one close bracket per flow, and a second intro mid-flow
    // produces a stray opening bracket in the rendered TUI.
    p.log.step("Final step: Background Service Installation");

    if (process.platform === "linux") {
      const sysEnv = ensureUserSystemdEnv();
      if (!sysEnv.ready && sysEnv.reason?.includes("enable linger first")) {
        // Resolve the username in Node, not the shell — `$USER` may be
        // unset/empty in stripped environments (some sudoers configs,
        // minimal containers) or contain unexpected characters that
        // would corrupt a shell-interpolated command. Fall back to
        // `os.userInfo()` which reads from the password database.
        const username = process.env.USER || userInfo().username;
        const lingerCmd = `sudo loginctl enable-linger ${username}`;
        p.note(
          "Linux requires 'linger' to run services in the background when you are not logged in.\n" +
          `We need to run '${lingerCmd}' to configure this.`,
          "Systemd Linger Required"
        );
        const installLinger = await p.confirm({
          message: "Allow sudo to enable linger?",
          initialValue: true,
        });

        if (p.isCancel(installLinger) || !installLinger) {
          p.cancel("Service installation skipped. You will need to start phantombot manually.");
          process.exitCode = 0;
          return;
        }

        try {
          // Pass the username as an explicit argv element rather than via a
          // shell-interpolated string — no command injection or word-splitting
          // surprises if the resolved username contains spaces or shell
          // metacharacters.
          execFileSync("sudo", ["loginctl", "enable-linger", username], { stdio: "inherit" });
          p.note("Linger enabled successfully.", "Success");
        } catch (error) {
          p.note(`Failed to enable linger. You may need to run '${lingerCmd}' manually.`, "Error");
        }
      }
    }

    const installConfirm = await p.confirm({
      message: "Install Phantombot as a background service now?",
      initialValue: true,
    });

    if (!p.isCancel(installConfirm) && installConfirm) {
      const installCode = await runInstall();
      if (installCode !== 0) {
        process.exitCode = installCode;
        return;
      }
      if (configured.length === 0) {
        p.outro("All done! Your Phantombot is running, but it has no configured harness.\nOnce you install and configure a harness (like gemini or claude), run `phantombot harness` to wire it up.");
      } else {
        p.outro("All done! Your Phantombot is now running and ready to chat.");
      }
    } else {
      if (configured.length === 0) {
        p.outro("Setup complete! Start your bot anytime with `phantombot run`.\nRemember to run `phantombot harness` after you configure an AI harness.");
      } else {
        p.outro("Setup complete! Start your bot anytime with `phantombot run`.");
      }
    }

    process.exitCode = 0;
  },
});
