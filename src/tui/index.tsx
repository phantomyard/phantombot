/**
 * TUI entry points.
 *
 * `startTui()` is what a bare, TTY-attached `phantombot` runs. `runRepl()` is
 * the same pipeline with the renderer removed (`phantombot --no-tui`), which is
 * also the honest degradation path: a terminal that cannot do full-screen still
 * gets a working conversation.
 *
 * Terminal hygiene is this module's responsibility, not a component's: the
 * stdin tap is installed BEFORE `render()` (see `stdinTap.ts`) and released on
 * every exit path, including a crash.
 */

import { render } from "ink";

import { App } from "./App.tsx";
import { installStdinTap } from "./stdinTap.ts";
import { enterFullScreen, gateStdout, forceRepaint } from "./terminal.ts";
import { logBuffer } from "./logBuffer.ts";
import { setPromptHost } from "./prompts.ts";
import { lendStdin } from "./stdinHandover.ts";
import { setLogSink } from "../lib/logSink.ts";
import { hostSnapshot } from "./snapshot.ts";
import { openChat } from "./chatSession.ts";
import type { WizardAnswers } from "./screens/Wizard.tsx";
import {
  loadConfig,
  loadConfigForPersona,
  servedPersonasOf,
} from "../config.ts";
import {
  personaCompleteness,
  type WizardStep,
} from "../lib/personaComplete.ts";
import { runPersonaNew } from "../cli/persona-new.ts";
import { log } from "../lib/logger.ts";
import { personaConfigPath } from "../lib/personaConfig.ts";
import { updateConfigToml, setIn } from "../lib/configWriter.ts";
import {
  listPersonaDirs,
  writeAutostartPersonas,
} from "../lib/personaDefault.ts";
import { defaultSyncHeartbeatInstances } from "../lib/systemd.ts";

/**
 * Decide what the app opens on.
 *
 * - No personas at all → the wizard, from the start.
 * - A default persona that fails the completeness predicate → the wizard,
 *   RESUMED at the failing step with prior answers pre-filled.
 * - Otherwise → chat with the default persona.
 */
export async function resolveOpeningScreen(): Promise<{
  persona?: string;
  wizardStartAt?: WizardStep;
}> {
  const host = await loadConfig();
  const { personas } = await hostSnapshot();
  if (personas.length === 0) return {};
  const target =
    personas.find((p) => p.name === host.defaultPersona) ?? personas[0]!;
  const { config } = await loadConfigForPersona(target.name);
  const completeness = await personaCompleteness(config, target.name);
  if (completeness.complete) return { persona: target.name };
  return { persona: target.name, wizardStartAt: completeness.resumeAt };
}

export async function startTui(): Promise<number> {
  const host = await hostSnapshot();
  const opening = await resolveOpeningScreen();

  // A terminal app owns the window. The alternate screen buffer is what makes
  // this look like `htop` rather than like output pasted under a shell prompt,
  // and leaving it puts the user's scrollback back untouched.
  const fullScreen = enterFullScreen();
  // Ink's writes go through a gate so a line-mode prompt can borrow the screen.
  const gate = gateStdout();
  // Logs are CAPTURED, not printed: stderr is the same terminal being drawn on,
  // so every log line used to land on top of the frame. `^l` shows the buffer.
  const restoreLogs = setLogSink((line) => logBuffer.push(line));
  // BEFORE render(): the tap must exist before Ink attaches to its stdin.
  const installed = installStdinTap();

  const element = (
    <App
      host={host}
      startPersona={opening.persona}
      wizardStartAt={opening.wizardStartAt}
      onCreatePersona={async (answers: WizardAnswers) => {
        return await createPhantomFromWizard(answers);
      }}
    />
  );

  const instance = render(element, {
    stdin: installed.stdin,
    stdout: gate.stream,
    exitOnCtrlC: false,
    // Rewrite only the lines that changed. The default redraws the whole frame
    // on every render, which at a 12fps spinner plus one repaint per keystroke
    // is visible as flicker; with it on, a tick costs a few dozen bytes on one
    // line instead of a full screen. Pairs with the reserved row in
    // `terminal.ts` — Ink only takes this path for a frame shorter than the
    // window.
    incrementalRendering: true,
  });

  /**
   * Hand the terminal to `@clack` and take it back.
   *
   * Ink cannot be paused, so the suspension is done around it: writes are
   * dropped, keystrokes stop being forwarded, and the alternate screen is left
   * so the prompt draws where the user's shell is. On
   * the way back the frame is repainted in full via `forceRepaint`, because
   * Ink diffs against a frame that is no longer on the screen and would
   * otherwise redraw only the part it thinks changed.
   */
  const restoreHost = setPromptHost(async (fn) => {
    gate.suspend();
    // A full detach, not just "stop forwarding": while the prompt or the editor
    // owns the terminal we must not be reading the same bytes it is.
    installed.setForwarding(false);
    fullScreen.restore();
    // Hand the stream over: snapshot the listeners the borrower will add, and
    // resume it so the borrower actually receives bytes. See `lendStdin`.
    const dropBorrowedListeners = lendStdin(process.stdin);
    try {
      return await fn();
    } finally {
      dropBorrowedListeners();
      fullScreen.enter();
      // Re-attaches the tap, restores raw mode, and RESUMES stdin — a readline
      // close or an inherited-stdin child leaves it paused, and a paused stdin
      // never emits `data` again, which is exactly what made the app come back
      // from `$EDITOR` deaf to every keystroke.
      installed.setForwarding(true);
      gate.resume();
      if (process.stdin.isTTY) process.stdin.setRawMode?.(true);
      instance.rerender(element);
      // NOT `instance.clear()`: it re-syncs Ink to the frame it just erased.
      // See `forceRepaint`.
      forceRepaint(gate);
    }
  });

  const restore = () => {
    restoreHost();
    restoreLogs();
    installed.teardown();
    fullScreen.restore();
  };
  installSignalExit(restore);

  try {
    await instance.waitUntilExit();
    return 0;
  } finally {
    restore();
  }
}

/**
 * Wire the TUI's exit paths: plain `exit`, plus SIGINT/SIGTERM from an outside
 * `kill` or a systemd stop (`^c` and `^q` go through Ink — raw mode means the
 * terminal generates no SIGINT).
 *
 * A signal listener suppresses Node's default termination, so restoring the
 * terminal and then RETURNING leaves a deaf app painting over the user's shell
 * — a second signal would be needed because `once` has already consumed the
 * handler. Restore, then exit with the conventional code (128 + signal). The
 * `exit` handler is the idempotent backstop; `FullScreen.restore` and
 * `installed.teardown` are both guarded, so the double call is harmless.
 *
 * Returns a teardown that removes the listeners — used by tests.
 */
export function installSignalExit(
  restore: () => void,
  exit: (code: number) => never = process.exit,
): () => void {
  const onSigint = () => {
    restore();
    exit(130);
  };
  const onSigterm = () => {
    restore();
    exit(143);
  };
  process.once("exit", restore);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return () => {
    process.off("exit", restore);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
}

/**
 * Create the phantom the wizard just described.
 *
 * Reuses `create-persona`'s non-interactive path rather than scaffolding a
 * second time — otherwise the TUI and the CLI produce differently shaped
 * personas and only one of them is tested.
 *
 * `makeDefault` is passed through as the wizard resolved it, which for a
 * second phantom is FALSE: `create-persona` currently offers `true` here, so a
 * mis-tapped Enter silently reassigns `default_persona` and with it ownership
 * of `/update` and `/restart`.
 */
export async function createPhantomFromWizard(
  answers: WizardAnswers,
  syncHeartbeatInstances: (
    personas: readonly string[],
  ) => Promise<unknown> = defaultSyncHeartbeatInstances,
): Promise<{ created: boolean }> {
  // Load the target's effective layer before creating it. With no persona file
  // yet this is the host chain; on a retry it also preserves any partial layer
  // that did make it to disk instead of borrowing the current default's chain.
  const target = await loadConfig(answers.name);
  const created = !listPersonaDirs(target).includes(answers.name);
  if (created) {
    let stderr = "";
    const code = await runPersonaNew({
      name: answers.name,
      harness: answers.brain,
      // Applied below for both new and resumed personas. Keeping this outside
      // the creation-only branch preserves the side effects on an incomplete
      // existing persona without asking `persona new` to overwrite it.
      autostart: false,
      makeDefault: answers.makeDefault,
      // The wizard's own output is the summary screen; the subcommand's stdout
      // would land underneath the rendered frame.
      out: { write: () => {} },
      err: { write: (chunk) => void (stderr += chunk) },
    });
    if (code !== 0) {
      throw new Error(
        stderr.trim() || `could not create persona '${answers.name}'`,
      );
    }
  }

  const autostartPersonas = await writeAutostartPersonas(target, [
    ...(target.autostartPersonas ?? []),
    answers.name,
  ]);
  try {
    await syncHeartbeatInstances(
      servedPersonasOf({
        defaultPersona: answers.makeDefault
          ? answers.name
          : target.defaultPersona,
        autostartPersonas,
      }),
    );
  } catch (e) {
    log.warn("could not provision wizard persona heartbeat instance", {
      persona: answers.name,
      error: (e as Error).message,
    });
  }

  // The review screen promises a persona-local config file. Record the chosen
  // brain there so the daemon reads the same choice the user just reviewed.
  // This deliberately bypasses resolvePersonaWriteTarget(): a new persona has
  // no config file yet, so that helper would target the global config. Preserve
  // inherited fallbacks while moving the chosen brain to the head of the chain.
  const chain = [
    answers.brain,
    ...(target.harnesses?.chain ?? []).filter((id) => id !== answers.brain),
  ];
  await updateConfigToml(
    personaConfigPath(target.personasDir, answers.name),
    (toml) => setIn(toml, ["harnesses", "chain"], chain),
  );
  return { created };
}

/**
 * `phantombot --no-tui` — the same conversation, line mode.
 *
 * No cursor addressing, no frame. Pipeable, and the fallback for any
 * terminal the full-screen renderer cannot drive.
 */
export async function runRepl(
  out: { write(chunk: string): void } = process.stdout,
): Promise<number> {
  const config = await loadConfig();
  const persona = config.defaultPersona;
  const chat = await openChat({ config, persona });
  out.write(`phantombot — talking to ${persona}. Ctrl-D to exit.\n`);
  try {
    for await (const line of console) {
      const text = String(line).trim();
      if (!text) continue;
      // Same dispatcher as the full-screen screen and as every channel: a
      // `/stop` typed into line mode must not be prompt text either.
      const command = await chat.command(text);
      if (command) {
        out.write(`${command.reply}\n`);
        if (command.afterSend) await command.afterSend();
        continue;
      }
      for await (const event of chat.send(text)) {
        if (event.type === "text") out.write(event.text);
        else if (event.type === "tool") out.write(`\n› ${event.title}\n`);
        else if (event.type === "error")
          out.write(`\nerror: ${event.message}\n`);
      }
      out.write("\n");
    }
    return 0;
  } catch (e) {
    log.warn("tui: repl failed", { error: (e as Error).message });
    return 1;
  } finally {
    await chat.close();
  }
}
