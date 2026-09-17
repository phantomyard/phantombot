/**
 * Should a bare `phantombot` open the full-screen TUI?
 *
 * This is a SECOND question asked after `isReadOnlyInvocation`, never a change
 * to it. That distinction is load-bearing:
 *
 *   `isReadOnlyInvocation(argv)` answers "may this invocation touch disk?" — and
 *   a bare call answers **true**, on purpose. CI uses bare `phantombot` and
 *   `--help` as "does the binary run?" smoke tests, and every shell <TAB> shells
 *   out through the same entrypoint, so the bare path must stay free of vault
 *   migration, persona provisioning and the tmp sweep.
 *
 *   `shouldOpenTui(argv, tty)` answers a different question: "is a HUMAN sitting
 *   in front of this?" Only when both stdin and stdout are TTYs do we boot the
 *   vault and open the app.
 *
 * The gate is therefore TTY-based, not argv-based. Getting that backwards is
 * not a cosmetic bug: an argv-based gate makes `phantombot | head` hang forever
 * waiting on a cursor-addressed renderer nobody is watching, and makes the CI
 * smoke test write to disk on a runner where nothing is configured.
 *
 * | invocation                              | result                            |
 * |-----------------------------------------|-----------------------------------|
 * | bare, stdin and stdout both TTYs        | open the TUI (chat / wizard)      |
 * | bare, piped / redirected / CI / cron    | today's usage text, read-only     |
 * | bare `--no-tui`                         | line-mode REPL, no full-screen    |
 * | `--help` / `--version` / `help` / any subcommand | unchanged            |
 *
 * Launch flags (issue #575) — `--prompt <text>` and `--persona <name>` — are
 * the one exception to "bare means no arguments". They exist so a desktop
 * launcher (Omarchy's default-agent picker) can hand a prompt to the TUI the
 * way it does to every other agent (`pi "$prompt"`, `claude -- "$prompt"`):
 *
 * | invocation                              | result                            |
 * |-----------------------------------------|-----------------------------------|
 * | launch flags, stdin and stdout TTYs     | open the TUI, seed/select         |
 * | launch flags, no TTY (piped, cron, CI)  | refuse: exit 2, point at `ask`    |
 * | launch flags with `--no-tui`            | refuse: exit 2, point at `ask`    |
 * | launch flag with a missing, empty, or   | refuse: exit 2                    |
 * |   flag-like value                       |                                   |
 * | a named phantom that does not exist     | refuse: exit 2                    |
 * |   (`--persona` or PHANTOMBOT_PERSONA)   |                                   |
 *
 * The TTY requirement IS the security model: a seeded prompt runs as a
 * TRUSTED turn because the human who launched it is watching it run. Headless
 * seeding would be an unattended trusted turn, so it is refused outright —
 * never silently rerouted to `ask` — and unattended callers use `phantombot
 * ask`, which goes through the threat judge.
 *
 * `--no-tui` is accepted on the bare invocation only. It is NOT a global flag:
 * every existing subcommand keeps its exact argument surface (the hard non-goal
 * of issue #471), so `phantombot doctor --no-tui` remains an unknown flag to
 * doctor, exactly as it is today.
 */

import { validPersonaName } from "../cli/persona-new.ts";

/** The flag that opts a bare invocation out of the full-screen renderer. */
export const NO_TUI_FLAG = "--no-tui";

export type BareInvocationMode =
  /** Full-screen Ink app: chat with the default phantom, or the wizard. */
  | "tui"
  /** Same pipeline, plain line-mode REPL, no cursor addressing. */
  | "repl"
  /** Today's behaviour: print usage, touch nothing. */
  | "usage"
  /** Launch flags that cannot be honoured; see `parseLaunchFlags`. */
  | "refuse";

export interface TtyState {
  stdin: boolean;
  stdout: boolean;
}

/**
 * Classify a bare invocation. `argv` is the full `process.argv`.
 *
 * Anything with a subcommand returns `"usage"` — meaning "not our business,
 * let Citty dispatch" — so a caller only has to special-case `tui` and `repl`.
 */
export function bareInvocationMode(
  argv: string[],
  tty: TtyState,
): BareInvocationMode {
  const args = argv.slice(2);
  if (args.length === 0) {
    // A REPL still needs a keyboard; without one, a bare pipe gets usage text.
    return tty.stdin && tty.stdout ? "tui" : "usage";
  }
  if (args.length === 1 && args[0] === NO_TUI_FLAG) {
    return tty.stdin ? "repl" : "usage";
  }
  const launch = parseLaunchFlags(argv);
  if (launch === null) return "usage";
  if ("error" in launch) return "refuse";
  return tty.stdin && tty.stdout ? "tui" : "refuse";
}

/** Seeds the first chat turn: `phantombot --prompt "…"`. */
export const PROMPT_FLAG = "--prompt";
/** Opens a named persona instead of the default: `phantombot --persona kai`. */
export const PERSONA_FLAG = "--persona";

export interface LaunchFlags {
  /** Sent as the first chat turn, exactly as if typed. */
  prompt?: string;
  /** The persona to open; the default-persona chain when absent. */
  persona?: string;
}

const HEADLESS_HINT =
  "--prompt and --persona open the interactive TUI and need a terminal on stdin and stdout. " +
  "For headless or scripted use run `phantombot ask`.";

/**
 * Parse a bare invocation's launch flags.
 *
 * Returns `null` when argv is not a launch-flag invocation at all (a
 * subcommand, `--help`, an unknown flag) so Citty keeps dispatching it exactly
 * as today. Returns `{ error }` for a launch invocation that must be refused,
 * so the caller can explain why instead of printing usage.
 *
 * Both `--flag value` and `--flag=value` are accepted. A flag given twice is an
 * error rather than last-wins: a launcher that builds argv badly should fail
 * loudly, not run a different prompt than the one it thinks it sent.
 */
export function parseLaunchFlags(
  argv: string[],
): LaunchFlags | { error: string } | null {
  const args = argv.slice(2);
  if (args.length === 0) return null;
  const out: LaunchFlags = {};
  let noTui = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === NO_TUI_FLAG) {
      noTui = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (name !== PROMPT_FLAG && name !== PERSONA_FLAG) return null;
    let value: string | undefined;
    if (eq !== -1) value = arg.slice(eq + 1);
    else {
      value = args[i + 1];
      // A detached value never swallows a following flag. Without this,
      // `--prompt --no-tui hi` would seed the literal text "--no-tui" and the
      // headless refusal would never fire — exactly the "runs a different
      // prompt than the launcher thinks it sent" failure this parser refuses
      // to have. `--prompt=--no-tui` is unaffected: an attached value is
      // unambiguous, so a prompt really may start with dashes.
      if (value !== undefined && value.startsWith("--"))
        return { error: `${name} needs a value; '${value}' looks like a flag.` };
      i++;
    }
    const key = name === PROMPT_FLAG ? "prompt" : "persona";
    if (out[key] !== undefined)
      return { error: `${name} was given more than once.` };
    if (value === undefined || value.trim() === "")
      return { error: `${name} needs a non-empty value.` };
    // The persona name becomes a directory under personas/ (and picks whose
    // vault is decrypted), so it is held to the same rule `persona new` uses.
    if (key === "persona" && !validPersonaName(value.trim()))
      return { error: `${name} '${value}' is not a valid persona name.` };
    out[key] = key === "persona" ? value.trim() : value;
  }
  if (out.prompt === undefined && out.persona === undefined) return null;
  if (noTui) return { error: HEADLESS_HINT };
  return out;
}

/**
 * Why a launch invocation was refused, for the one line printed before exit 2.
 * Only meaningful when `bareInvocationMode` returned `"refuse"`.
 */
export function launchRefusal(argv: string[]): string {
  const launch = parseLaunchFlags(argv);
  if (launch && "error" in launch) return launch.error;
  return HEADLESS_HINT;
}

/** Convenience wrapper: true when the full-screen app should open. */
export function shouldOpenTui(argv: string[], tty: TtyState): boolean {
  return bareInvocationMode(argv, tty) === "tui";
}

/** Read the live TTY state off a process-like object. */
export function currentTty(
  proc: { stdin: { isTTY?: boolean }; stdout: { isTTY?: boolean } } = process,
): TtyState {
  return {
    stdin: proc.stdin.isTTY === true,
    stdout: proc.stdout.isTTY === true,
  };
}


/** Where a launch's persona name came from — the three rungs of the chain. */
export type LaunchPersonaSource = "flag" | "env" | "default";

export interface LaunchPersona {
  /** The persona this launch is for. */
  name: string;
  /** Which rung of the chain supplied it. */
  source: LaunchPersonaSource;
}

/**
 * WHICH PHANTOM A LAUNCH IS FOR — resolved ONCE, here, and then used for
 * everything downstream: the vault the entrypoint decrypts, the
 * unknown-persona check, and the screen the TUI opens.
 *
 * Precedence is the same chain the rest of the CLI uses (`resolvePersona` in
 * config.ts) with one flag added in front: `--persona` beats the
 * harness-injected `PHANTOMBOT_PERSONA`, which beats the configured default
 * (state.json, then config.toml — `loadConfig` has already collapsed those two
 * into `defaultPersona`).
 *
 * Resolving it once is the whole point. Resolving the vault from the full chain
 * but the chat screen from the FLAG ALONE pairs one phantom's decrypted secrets
 * with another phantom's conversation: with `PHANTOMBOT_PERSONA=lena` and the
 * default `robbie`, `phantombot --prompt "…"` would decrypt Lena's vault and
 * then send the trusted seed to Robbie. The `source` rides along because the
 * three rungs do NOT fail the same way — see `launchOpeningTarget`.
 */
export function resolveLaunchPersona(
  launch: LaunchFlags,
  env: Record<string, string | undefined>,
  defaultPersona: string,
): LaunchPersona {
  if (launch.persona) return { name: launch.persona, source: "flag" };
  const fromEnv = env.PHANTOMBOT_PERSONA?.trim();
  if (fromEnv) return { name: fromEnv, source: "env" };
  return { name: defaultPersona, source: "default" };
}

/**
 * The message for a launch persona that does not exist on this host, or
 * `undefined` when it does.
 *
 * The three rungs of the chain fail differently, and that difference is
 * deliberate:
 *
 *   - `--persona kia` is a bad ARGUMENT. Refuse it before the screen is taken
 *     over, rather than treating it as "nothing is set up" and opening the
 *     wizard to create a phantom the user never asked for.
 *   - `PHANTOMBOT_PERSONA=kia` is a bad ENVIRONMENT, and refusing is still the
 *     honest answer: the entrypoint has already resolved the vault from this
 *     same name, so carrying on would open some other phantom's chat with no
 *     secrets loaded at all. Every other persona-aware command likewise targets
 *     the env name rather than silently substituting the default.
 *   - the configured DEFAULT naming a missing persona is not a bad input at
 *     all: it is the broken-default case that `resolveOpeningScreen` already
 *     owns (heal once, else wizard), so it is not refused here.
 */
export function unknownLaunchPersona(
  persona: LaunchPersona,
  personas: readonly { name: string }[],
): string | undefined {
  if (persona.source === "default") return undefined;
  if (personas.some((p) => p.name === persona.name)) return undefined;
  const known = personas.map((p) => p.name).join(", ") || "none yet";
  if (persona.source === "flag")
    return `no persona named '${persona.name}' (personas: ${known}).`;
  return `PHANTOMBOT_PERSONA names '${persona.name}', which does not exist (personas: ${known}).`;
}

/** What a launch opens: a refusal, or the persona to hand the opening screen. */
export type LaunchTarget =
  | { refusal: string }
  | {
      /**
       * Passed to `resolveOpeningScreen` as its `requested` persona.
       * `undefined` when the name came from the configured default, so the
       * default-persona chain (legacy adoption, heal-if-broken) stays exactly
       * as it is for a bare launch — a resolved default is not a request.
       */
      requested: string | undefined;
      /** The resolved persona this launch is for, whatever the rung. */
      persona: LaunchPersona;
    };

/**
 * Resolve the launch persona and check it exists, in one place both the
 * entrypoint and the TUI can agree on.
 */
export function launchOpeningTarget(
  launch: LaunchFlags,
  env: Record<string, string | undefined>,
  host: { defaultPersona: string; personas: readonly { name: string }[] },
): LaunchTarget {
  const persona = resolveLaunchPersona(launch, env, host.defaultPersona);
  const unknown = unknownLaunchPersona(persona, host.personas);
  if (unknown !== undefined) return { refusal: unknown };
  return {
    requested: persona.source === "default" ? undefined : persona.name,
    persona,
  };
}
