/**
 * TUI entry points.
 *
 * `startTui()` is what a bare, TTY-attached `phantombot` runs. `runRepl()` is
 * the same pipeline with the renderer removed (`phantombot --no-tui`), which is
 * also the honest degradation path: a terminal that cannot do full-screen still
 * gets a working conversation.
 *
 * Terminal hygiene is this module's responsibility, not a component's: mouse
 * reporting is enabled BEFORE `render()` (see `mouse.ts`) and disabled on every
 * exit path, including a crash, so nothing can leave the user's shell emitting
 * escape codes.
 */

import { render } from "ink";

import { App } from "./App.tsx";
import { installMouse } from "./mouse.ts";
import { hostSnapshot } from "./snapshot.ts";
import { openChat } from "./chatSession.ts";
import type { WizardAnswers } from "./screens/Wizard.tsx";
import { loadConfig, loadConfigForPersona } from "../config.ts";
import { personaCompleteness, type WizardStep } from "../lib/personaComplete.ts";
import { runPersonaNew } from "../cli/persona-new.ts";
import { log } from "../lib/logger.ts";

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

  // BEFORE render(): with the stdin tap attached from a useEffect instead, the
  // mouse RELEASE event is swallowed reproducibly. See mouse.ts.
  const installed = installMouse();

  const instance = render(
    <App
      host={host}
      startPersona={opening.persona}
      wizardStartAt={opening.wizardStartAt}
      onCreatePersona={async (answers: WizardAnswers) => {
        await createPhantomFromWizard(answers);
      }}
    />,
    { stdin: installed.stdin, exitOnCtrlC: false },
  );

  const restore = () => installed.teardown();
  process.once("exit", restore);
  process.once("SIGINT", restore);
  process.once("SIGTERM", restore);

  try {
    await instance.waitUntilExit();
    return 0;
  } finally {
    restore();
  }
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
): Promise<void> {
  const code = await runPersonaNew({
    name: answers.name,
    harness: answers.brain,
    autostart: true,
    makeDefault: answers.makeDefault,
    // The wizard's own output is the summary screen; the subcommand's stdout
    // would land underneath the rendered frame.
    out: { write: () => {} },
    err: { write: () => {} },
  });
  if (code !== 0) throw new Error(`could not create persona '${answers.name}'`);
}

/**
 * `phantombot --no-tui` — the same conversation, line mode.
 *
 * No cursor addressing, no frame, no mouse. Pipeable, and the fallback for any
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
      for await (const event of chat.send(text)) {
        if (event.type === "text") out.write(event.text);
        else if (event.type === "tool") out.write(`\n› ${event.title}\n`);
        else if (event.type === "error") out.write(`\nerror: ${event.message}\n`);
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
