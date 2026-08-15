/**
 * `phantombot persona` — single entry point for persona management.
 *
 * Replaces the previous `phantombot create-persona` and
 * `phantombot import-persona` top-level subcommands. The argument grammar:
 *
 *   phantombot persona                       — TUI: current persona + menu
 *                                              (create / import / restore / switch)
 *   phantombot persona <name>                — switch default persona to <name>
 *                                              (positional; <name> must exist)
 *   phantombot persona --import <dir>        — import non-interactively
 *   phantombot persona --import <dir> --as N — import with explicit target name
 *
 * The `--import` flag and a positional <name> are mutually exclusive; pass
 * `--as` with `--import` to set the target name instead of using a positional.
 *
 * The underlying create / import / restore work still lives in
 * `src/cli/create-persona.ts` and `src/cli/import-persona.ts` — those files
 * keep their `run*` exports for direct programmatic use and existing tests.
 * Only their `defineCommand(...)` defaults are removed so phantombot's
 * dispatcher only exposes the consolidated entry point.
 */

import { defineCommand } from "citty";
import { existsSync, readdirSync } from "node:fs";
import * as p from "@clack/prompts";

import {
  type Config,
  loadConfig,
  personaDir,
} from "../config.ts";
import type { WriteSink } from "../lib/io.ts";
import { log } from "../lib/logger.ts";
import { listArchives } from "../lib/personaArchive.ts";
import { defaultServiceControl, type ServiceControl } from "../lib/platform.ts";
import { loadState, saveState } from "../state.ts";
import { runCreatePersona } from "./create-persona.ts";
import { runImportPersona } from "./import-persona.ts";
import { defaultConfirm, maybePromptRestart, type ConfirmFn } from "./harness.ts";

export interface RunPersonaInput {
  /** Positional <name> — switch default. Mutually exclusive with `import`. */
  name?: string;
  /** Import flag value: path to a persona dir to import. */
  import?: string;
  /** Override target persona name on import. Default: basename(import). */
  as?: string;
  /** Skip the OpenClaw Telegram sniff during import. */
  noTelegram?: boolean;
  /** Confirm a default-persona switch non-interactively (switch path only). */
  yes?: boolean;
  config?: Config;
  serviceControl?: ServiceControl;
  out?: WriteSink;
  err?: WriteSink;
}

export async function runPersona(input: RunPersonaInput = {}): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;

  if (input.import && input.name) {
    err.write(
      "specify --as <name> with --import; don't combine --import with a positional name.\n",
    );
    return 2;
  }

  if (input.import) {
    return runImportPersona({
      source: input.import,
      as: input.as,
      overwrite: false,
      noTelegram: input.noTelegram,
      config: input.config,
      serviceControl: input.serviceControl,
      out,
      err,
    });
  }

  if (input.name) {
    return runSwitchPersona({
      name: input.name,
      yes: input.yes,
      config: input.config,
      serviceControl: input.serviceControl,
      out,
      err,
    });
  }

  return runPersonaMenu({
    config: input.config,
    serviceControl: input.serviceControl,
    out,
    err,
  });
}

/**
 * Switch the default persona to `name`. Validates that the persona dir
 * exists; refuses with a clear error if it doesn't, listing available
 * personas. Persists the switch only after an explicit confirmation
 * (`--yes`, a confirm prompt, or an injected `confirm` in tests), and
 * refuses agent-scoped switches that would re-point the daemon-wide
 * default persona (see #371).
 */
export interface RunSwitchPersonaInput {
  name: string;
  /** Skip the interactive confirm (already consented non-interactively). */
  yes?: boolean;
  /**
   * Injected confirm for tests; defaults to the @clack-backed
   * `defaultConfirm`. When omitted, non-TTY invocations without `yes`
   * are refused instead of prompting (see `runSwitchPersona`).
   */
  confirm?: ConfirmFn;
  /**
   * Injected TTY detection for tests; defaults to
   * `process.stdin.isTTY && process.stdout.isTTY`. Lets tests drive the
   * interactive prompt branch without a real TTY.
   */
  isInteractive?: boolean;
  config?: Config;
  serviceControl?: ServiceControl;
  out?: WriteSink;
  err?: WriteSink;
}

export async function runSwitchPersona(
  input: RunSwitchPersonaInput,
): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const config = input.config ?? (await loadConfig());

  const targetDir = personaDir(config, input.name);
  if (!existsSync(targetDir)) {
    const available = listExistingPersonas(config);
    err.write(
      `persona '${input.name}' not found at ${targetDir}\n` +
        (available.length > 0
          ? `available: ${available.join(", ")}\n`
          : "no personas exist yet — create one with `phantombot persona`.\n"),
    );
    return 1;
  }

  const state = await loadState();
  const previous = state.default_persona ?? config.defaultPersona;
  if (previous === input.name) {
    out.write(`'${input.name}' is already the default.\n`);
    return 0;
  }

  // Scope check: a persona agent (harness sets PHANTOMBOT_PERSONA) must not
  // re-point the daemon-wide default. Its `phantombot persona <name>` is a
  // read/self-intent mistake, not a switch instruction — refuse it. (The
  // "already the default" no-op above already returned for previous === name,
  // so reaching here means the agent is about to change the global default.)
  const agentPersona = process.env.PHANTOMBOT_PERSONA?.trim();
  if (agentPersona) {
    err.write(
      `refusing to switch default_persona to '${input.name}': running as ` +
        `persona '${agentPersona}' (PHANTOMBOT_PERSONA). Persona agents can't ` +
        `re-point the daemon-wide default; use --persona for per-invocation ` +
        `scope instead.\n`,
    );
    return 2;
  }

  // Confirm before persisting. In a non-TTY context (agent Bash, cron, CI)
  // the @clack prompt can't be answered, so require an explicit --yes.
  const interactive =
    input.isInteractive ??
    Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let confirmed: boolean;
  if (input.yes) {
    confirmed = true;
  } else if (input.confirm) {
    confirmed = await input.confirm(
      `Switch default persona to '${input.name}'?`,
    );
  } else if (interactive) {
    confirmed = await defaultConfirm(
      `Switch default persona to '${input.name}'?`,
    );
  } else {
    err.write(
      `not switching: default_persona change needs confirmation. ` +
        `Re-run with --yes to switch '${previous ?? "(unset)"}' → '${input.name}'.\n`,
    );
    return 2;
  }

  if (!confirmed) {
    out.write("switch cancelled.\n");
    return 0;
  }

  // Re-validate the persona dir right before committing: the confirmation
  // wait may have raced with a concurrent remove, and we must not point the
  // default at a persona that no longer exists.
  if (!existsSync(targetDir)) {
    err.write(`persona '${input.name}' no longer exists at ${targetDir}\n`);
    return 1;
  }

  // Persist only after confirmation (the #371 ordering fix). Re-load the
  // state fresh instead of reusing the snapshot captured above: the
  // confirmation wait can overlap another writer (e.g. harness_bins
  // discovery), and writing the stale snapshot would clobber its fields.
  const latestState = await loadState();
  const latestPrevious =
    latestState.default_persona ?? config.defaultPersona;
  latestState.default_persona = input.name;
  await saveState(latestState);
  out.write(
    `default_persona: '${latestPrevious ?? "(unset)"}' → '${input.name}'\n`,
  );

  const svc = input.serviceControl ?? defaultServiceControl();
  await maybePromptRestart(svc);
  return 0;
}

interface RunPersonaMenuInput {
  config?: Config;
  serviceControl?: ServiceControl;
  out: WriteSink;
  err: WriteSink;
}

/**
 * The interactive TUI menu. Shows current persona, lists what's on disk,
 * and offers create / import / restore / switch / cancel. Each action
 * delegates to the relevant existing run* function.
 */
async function runPersonaMenu(input: RunPersonaMenuInput): Promise<number> {
  const config = input.config ?? (await loadConfig());

  p.intro("Persona");

  const personas = listExistingPersonas(config);
  const currentDefault = config.defaultPersona;
  const defaultExists = personas.includes(currentDefault);

  if (defaultExists) {
    p.note(
      `Current default: ${currentDefault}\n  ${personaDir(config, currentDefault)}\n` +
        `On disk: ${personas.join(", ")}`,
      "Status",
    );
  } else if (personas.length > 0) {
    p.note(
      `Default ('${currentDefault}') doesn't exist on disk.\nOn disk: ${personas.join(", ")}`,
      "Status",
    );
  } else {
    p.note("No personas yet. Create or import one to get started.", "Status");
  }

  type Action = "create" | "import" | "restore" | "switch" | "cancel";
  const archives = await listArchives(config.personasDir);
  const switchableCount = personas.filter((n) => n !== currentDefault).length;

  const action = await p.select<Action>({
    message: "What do you want to do?",
    options: [
      { value: "create", label: "Create a new persona" },
      {
        value: "import",
        label: "Import from a directory (OpenClaw or phantombot-shaped)",
      },
      {
        value: "restore",
        label: `Restore an archived persona (${archives.length} available)`,
        hint: archives.length === 0 ? "none yet" : undefined,
      },
      {
        value: "switch",
        label: "Switch the default persona",
        hint:
          switchableCount === 0
            ? "create or import another first"
            : `${switchableCount} other(s) available`,
      },
      { value: "cancel", label: "Cancel" },
    ],
  });
  if (p.isCancel(action) || action === "cancel") {
    p.cancel("cancelled");
    return 0;
  }

  if (action === "create") {
    return runCreatePersona({ config, out: input.out });
  }
  if (action === "import" || action === "restore") {
    // runImportPersona without a source falls into its own TUI which
    // already handles both "import from a directory" and "restore from
    // archive" — we just route there. Could split later if the menus
    // need to diverge.
    return runImportPersona({
      config,
      serviceControl: input.serviceControl,
      out: input.out,
      err: input.err,
    });
  }
  if (action === "switch") {
    if (switchableCount === 0) {
      p.cancel("nothing to switch to.");
      return 0;
    }
    const pick = await p.select<string>({
      message: "Switch default persona to",
      options: personas
        .filter((n) => n !== currentDefault)
        .map((n) => ({ value: n, label: n })),
    });
    if (p.isCancel(pick)) {
      p.cancel("cancelled");
      return 0;
    }
    const code = await runSwitchPersona({
      name: pick as string,
      config,
      serviceControl: input.serviceControl,
      out: input.out,
      err: input.err,
    });
    p.outro("done");
    return code;
  }
  return 0;
}

/**
 * Read the personas directory and return the names of subdirectories
 * (each subdir = one persona). Returns [] if the personas dir doesn't
 * exist yet — fresh installs have no personas.
 *
 * Non-ENOENT read failures (EACCES, EIO, etc.) still return [] so the
 * caller's UI keeps working, but they're logged to stderr first so the
 * user has a hint that the empty list isn't the same as "no personas."
 */
export function listExistingPersonas(config: Config): string[] {
  if (!existsSync(config.personasDir)) return [];
  try {
    return readdirSync(config.personasDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (e) {
    log.warn("persona: failed to read personas dir", {
      personasDir: config.personasDir,
      error: (e as Error).message,
    });
    return [];
  }
}

export default defineCommand({
  meta: {
    name: "persona",
    description:
      "Manage personas: create, import, switch, or list. Run with no args for the TUI; pass <name> to switch; pass --import <dir> to import non-interactively.",
  },
  args: {
    name: {
      type: "positional",
      description:
        "Switch default persona to <name>. Mutually exclusive with --import.",
      required: false,
    },
    import: {
      type: "string",
      description:
        "Import a persona directory (OpenClaw or phantombot-shaped) non-interactively.",
    },
    as: {
      type: "string",
      description:
        "Target persona name when importing. Default: basename of the source directory.",
    },
    "no-telegram": {
      type: "boolean",
      description:
        "Skip the OpenClaw Telegram config sniff at ~/.openclaw/openclaw.json.",
      default: false,
    },
    yes: {
      type: "boolean",
      description:
        "Confirm a default-persona switch without prompting (non-interactive consent).",
      default: false,
    },
  },
  async run({ args }) {
    process.exitCode = await runPersona({
      name: args.name ? String(args.name) : undefined,
      import: args.import ? String(args.import) : undefined,
      as: args.as ? String(args.as) : undefined,
      noTelegram: Boolean(args["no-telegram"]),
      yes: Boolean(args.yes),
    });
  },
});
