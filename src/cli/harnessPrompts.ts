/**
 * The questions `phantombot harness` asks, behind ONE injectable interface.
 *
 * The harness flow is the longest wizard in the product and the only one the
 * TUI could not host: it called @clack directly, so the Brain row had to hand
 * the terminal over — no frame, no footer, and a sequence of readline prompts
 * that fought the app for stdin. Reimplementing it as screens would have meant
 * two flows drifting apart, and this one writes routing, vault keys and
 * tombstones — the last place a second implementation belongs.
 *
 * So the flow stays exactly where it is and the ASKING is injected. `clack`
 * (the default) keeps the CLI byte-identical; the TUI passes screens.
 *
 * Cancellation is `undefined` from any method, on purpose: clack's
 * `isCancel` symbol is a clack detail, and an interface that leaks it forces
 * every other implementation to import clack to say "the user pressed esc".
 */

import * as p from "@clack/prompts";

export interface HarnessPrompts {
  select<T extends string>(input: {
    message: string;
    options: ReadonlyArray<{ value: T; label: string; hint?: string }>;
    initialValue?: T;
  }): Promise<T | undefined>;
  text(input: {
    message: string;
    placeholder?: string;
    initialValue?: string;
    defaultValue?: string;
  }): Promise<string | undefined>;
  password(input: { message: string }): Promise<string | undefined>;
  confirm(input: {
    message: string;
    initialValue?: boolean;
  }): Promise<boolean | undefined>;
  /** Informational panel. Never blocks a non-interactive caller. */
  note(body: string, title?: string): void;
  intro(message: string): void;
  outro(message: string): void;
  cancel(message: string): void;
  /**
   * Whether this implementation can hand the terminal to another program.
   * The Pi installer inherits stdin and paints its own onboarding, which a
   * full-screen app cannot allow mid-render — so the TUI says false and the
   * flow prints the command to run instead of wedging the screen.
   */
  canRunInteractiveInstaller: boolean;
}

/** The CLI's own asking — unchanged behaviour for `phantombot harness`. */
export const clackPrompts: HarnessPrompts = {
  async select(input) {
    const r = await p.select({
      message: input.message,
      options: input.options as never,
      initialValue: input.initialValue as never,
    });
    return p.isCancel(r) ? undefined : (r as never);
  },
  async text(input) {
    const r = await p.text(input);
    return p.isCancel(r) ? undefined : (r as string);
  },
  async password(input) {
    const r = await p.password(input);
    return p.isCancel(r) ? undefined : (r as string);
  },
  async confirm(input) {
    const r = await p.confirm({
      message: input.message,
      initialValue: input.initialValue,
    });
    return p.isCancel(r) ? undefined : (r as boolean);
  },
  canRunInteractiveInstaller: true,
  note: (body, title) => p.note(body, title),
  intro: (message) => p.intro(message),
  outro: (message) => p.outro(message),
  cancel: (message) => p.cancel(message),
};

/**
 * A non-interactive implementation: every question cancels, notes are
 * collected. Used by callers that must never block (and by tests).
 */
export function collectingPrompts(sink: string[]): HarnessPrompts {
  const none = async () => undefined;
  return {
    canRunInteractiveInstaller: false,
    select: none,
    text: none,
    password: none,
    confirm: none,
    note: (body, title) => sink.push(title ? `${title}: ${body}` : body),
    intro: () => {},
    outro: () => {},
    cancel: (m) => sink.push(m),
  };
}
