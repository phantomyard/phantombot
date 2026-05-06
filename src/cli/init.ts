import { execFile, execSync } from "node:child_process";

import { defineCommand } from "citty";
import * as p from "@clack/prompts";

import { loadConfig } from "../config.ts";
import { ensureUserSystemdEnv } from "../lib/systemd.ts";
import { runHarness } from "./harness.ts";
import { runInstall } from "./install.ts";
import { runPersona } from "./persona.ts";
import { runTelegram } from "./telegram.ts";

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
    console.clear();
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
    
    // We check which ones are on PATH first
    const { detectAvailability } = await import("./harness.ts");
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
        "No AI harness replied to a test 'hello'.\n" +
        "You might need to authenticate with them first (e.g. running 'claude' or 'pi' manually), " +
        "but we can still set up the configuration now.",
        "Probe result"
      );
    }

    // 1. Harness

    const harnessCode = await runHarness();
    if (harnessCode !== 0) {
      process.exitCode = harnessCode;
      return;
    }

    // 2. Persona
    const personaCode = await runPersona();
    if (personaCode !== 0) {
      process.exitCode = personaCode;
      return;
    }

    // 3. Telegram
    const telegramCode = await runTelegram();
    if (telegramCode !== 0) {
      process.exitCode = telegramCode;
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
        p.note(
          "Linux requires 'linger' to run services in the background when you are not logged in.\n" +
          "We need to run 'sudo loginctl enable-linger $USER' to configure this.",
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
          execSync(`sudo loginctl enable-linger $USER`, { stdio: "inherit" });
          p.note("Linger enabled successfully.", "Success");
        } catch (error) {
          p.note("Failed to enable linger. You may need to run 'sudo loginctl enable-linger $USER' manually.", "Error");
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
