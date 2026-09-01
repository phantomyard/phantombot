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
import { reconcileAutostart } from "../lib/autostartReconcile.ts";
import {
  enterFullScreen,
  gateStdout,
  forceRepaint,
  KITTY_POP,
  KITTY_PUSH,
} from "./terminal.ts";
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
  adoptLegacyDefaultPersona,
  configLayerDefaultPersona,
  defaultPersonaProvenance,
  healDefaultPersonaIfBroken,
  listPersonaDirs,
  writeAutostartPersonas,
} from "../lib/personaDefault.ts";
import { defaultSyncHeartbeatInstances } from "../lib/systemd.ts";

/**
 * Decide what the app opens on, in three tiers:
 *
 * 0. Legacy migration first: a host with personas on disk but NO default
 *    persona configured anywhere (env > state.json > config.toml all empty)
 *    adopts the pre-#509 fallback choice (resolved default, else
 *    `personas[0]`) as an explicit `default_persona` — exactly what the
 *    pre-#509 silent fallback did — so an upgraded host opens where it always
 *    did instead of in the wizard.
 *
 * 1. No personas, no default persona configured, or a default persona whose
 *    identity is missing — the gap the wizard itself exists to set up — → the
 *    New Persona wizard. Resumed at the identity question when a persona
 *    exists; from the start when none does.
 * 2. A default persona with identity but no brain of its own → its Configure
 *    screen. Not a wizard gap: a brain is chosen in Configure, and the red
 *    `required` Brain row there is the nudge.
 * 3. Identity + brain present → chat with the default persona.
 */
export type OpeningScreen = "chat" | "configure" | "wizard";

export async function resolveOpeningScreen(): Promise<{
  screen: OpeningScreen;
  persona?: string;
  wizardStartAt?: WizardStep;
}> {
  let host = await loadConfig();
  const { personas } = await hostSnapshot();
  if (personas.length === 0 || !host.defaultPersona)
    return { screen: "wizard" };
  // Legacy installs (see adoptLegacyDefaultPersona): before #509 the TUI fell
  // back to `personas.find((p) => p.name === defaultPersona) ?? personas[0]` —
  // with no default configured anywhere that resolves against the builtin
  // "phantom", so a host that actually had a "phantom" persona opened THAT,
  // not the alphabetically first. Reproduce the expression exactly, then make
  // it explicit once, so an upgraded working host opens where it always did
  // instead of in the wizard. Gated on provenance "builtin": an
  // explicitly-configured or healed default — even a broken one — is never
  // touched here.
  if (
    personas.length > 0 &&
    (await defaultPersonaProvenance(host)) === "builtin"
  ) {
    // Best-effort: an unwritable config.toml must degrade to the
    // pre-migration screen, never abort TUI launch on the hosts this
    // migration exists to rescue.
    try {
      const legacyFallback =
        personas.find((p) => p.name === host.defaultPersona) ?? personas[0]!;
      await adoptLegacyDefaultPersona(host, legacyFallback.name);
    } catch (err) {
      log.warn(
        "legacy install: default-persona adoption failed; continuing unmigrated",
        { error: String(err) },
      );
    }
  }
  // Same legacy contract for autostart, generalised: reconcile the recorded
  // autostart config against what the host actually does. This subsumes the
  // one-shot pre-#509 backfill (which was gated on [autostart_modes] being
  // entirely empty, so it never repaired a partially-recorded host) and also
  // prunes records and list entries naming personas that no longer exist.
  // MIRROR-ONLY: it writes config, never units/tasks/plists — see
  // lib/autostartReconcile.ts. Best-effort for the same reason as the
  // adoption above: an unwritable config.toml must degrade to a stale label,
  // never abort TUI launch on the hosts this repair exists to rescue.
  try {
    await reconcileAutostart(host);
  } catch (err) {
    log.warn(
      "legacy install: autostart reconcile failed; continuing with recorded config",
      { error: String(err) },
    );
  }
  let target = personas.find((p) => p.name === host.defaultPersona);
  if (!target) {
    // Broken default — e.g. a stale state.json entry pointing at a persona
    // that no longer exists. The heal path owns broken defaults: heal ONCE
    // (preferring the operator-explicit config.toml choice), then proceed as
    // if that default had always been set. Nothing to heal → wizard.
    const healed = await healDefaultPersonaIfBroken(
      host,
      undefined,
      await configLayerDefaultPersona(host),
    );
    if (!healed) return { screen: "wizard" };
    host.defaultPersona = healed;
    target = personas.find((p) => p.name === healed);
  }
  if (!target) return { screen: "wizard" };
  const { config } = await loadConfigForPersona(target.name);
  const completeness = await personaCompleteness(config, target.name);
  const requirement = (id: (typeof completeness.requirements)[number]["id"]) =>
    completeness.requirements.find((r) => r.id === id)!;
  // Identity is the one wizard-fixable gap. A memory-DB failure is a repair
  // case, not a setup flow (the wizard cannot fix it), so it falls through to
  // the tiers below and surfaces as the not-ready badge.
  if (!requirement("identity").ok) {
    return {
      screen: "wizard",
      persona: target.name,
      wizardStartAt: completeness.resumeAt,
    };
  }
  if (!requirement("brain").ok) return { screen: "configure", persona: target.name };
  return { screen: "chat", persona: target.name };
}

export async function startTui(): Promise<number> {
  // FIRST, before any awaited startup work: logs are CAPTURED, not printed —
  // stderr is the same terminal being drawn on, so every log line used to land
  // on top of the frame. Installed ahead of `hostSnapshot()` on purpose (#478):
  // snapshotting is the noisiest part of startup, and with the sink installed
  // after it every one of those lines was lost to stderr, which is a large part
  // of why the log pane opened empty.
  const restoreLogs = setLogSink((line) => logBuffer.push(line));
  const host = await hostSnapshot();
  const opening = await resolveOpeningScreen();
  const startScreen = opening.screen === "configure" ? "configure" : undefined;

  // A terminal app owns the window. The alternate screen buffer is what makes
  // this look like `htop` rather than like output pasted under a shell prompt,
  // and leaving it puts the user's scrollback back untouched.
  const fullScreen = enterFullScreen();
  // Ink's writes go through a gate so a line-mode prompt can borrow the screen.
  const gate = gateStdout();
  // BEFORE render(): the tap must exist before Ink attaches to its stdin.
  const installed = installStdinTap();

  const element = (
    <App
      host={host}
      startPersona={opening.persona}
      startScreen={startScreen}
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
    // Shift/Ctrl/Alt+Enter as distinct keys in the chat box: Ink 6 parses the
    // kitty keyboard protocol but only enables it for kitty/WezTerm/Ghostty,
    // so we push flag 1 (disambiguate escape codes) ourselves. Terminals that
    // don't support it ignore the sequence and stay legacy — ctrl+J remains
    // the universal newline there. Popped around clack handovers below.
    kittyKeyboard: { mode: "enabled", flags: ["disambiguateEscapeCodes"] },
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
    // Legacy bytes for the borrower: a clack readline or `$EDITOR` cannot
    // parse CSI-u Enter, so the kitty flags come off while it owns stdin.
    process.stdout.write(KITTY_POP);
    // Hand the stream over: snapshot the listeners the borrower will add, and
    // resume it so the borrower actually receives bytes. See `lendStdin`.
    const dropBorrowedListeners = lendStdin(process.stdin);
    try {
      return await fn();
    } finally {
      dropBorrowedListeners();
      // Flags back on BEFORE anything reads stdin again — the pop must never
      // outlive the handover, or Enter would arrive as a bare `\r` mid-frame.
      process.stdout.write(KITTY_PUSH);
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
    // Belt for signal exits: Ink pops its own flags on unmount, but a SIGTERM
    // path may not reach it — and a shell left in flag-1 mode gets CSI-u
    // garbage on every Enter. Extra pops are ignored.
    process.stdout.write(KITTY_POP);
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
      identity: answers.identity,
      tone: answers.tone,
      owner: answers.owner,
      expertise: answers.expertise,
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

  const autostartPersonas = await writeAutostartPersonas(
    target,
    // Autostart is OFF unless the host already uses it: a host with an empty
    // `autostart_personas` (the “phantoms run when I open them” mode) does not
    // silently conscript every new persona into the daemon fleet. Joining an
    // existing autostart list is the detected case.
    (target.autostartPersonas ?? []).length > 0
      ? [...(target.autostartPersonas ?? []), answers.name]
      : (target.autostartPersonas ?? []),
  );
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
  // The three-question create flow (CreatePersona.tsx) picks no brain, so it
  // writes nothing here — the persona inherits the host chain until the
  // Configure screen's Brain flow records a choice.
  if (answers.brain !== undefined) {
    const chain = [
      answers.brain,
      ...(target.harnesses?.chain ?? []).filter((id) => id !== answers.brain),
    ];
    await updateConfigToml(
      personaConfigPath(target.personasDir, answers.name),
      (toml) => setIn(toml, ["harnesses", "chain"], chain),
    );
  }
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
