/**
 * `phantombot persona new <name> [--autostart] [--default]`
 *
 * A non-interactive persona creator. It exists so the flow the TUI wizard
 * drives can be scripted and documented WITHOUT describing a full-screen app —
 * a runbook can say "run this" rather than "press these keys".
 *
 * This ADDS a subcommand; it changes no existing one. `phantombot persona` and
 * `phantombot persona <name>` keep their exact behaviour (the hard non-goal of
 * issue #471: the CLI does not change).
 *
 * `--default` is opt-in and never implied. Reassigning `default_persona` moves
 * ownership of `/update` and `/restart` to the new phantom, which is not
 * something a create command should do by accident. The one exception is
 * inherited from `applyPersona`: a configured default with no directory on disk
 * is adopted, because otherwise the daemon boots pointing at nothing.
 */

import { defineCommand } from "citty";

import { type Config, loadConfig, servedPersonasOf } from "../config.ts";
import { applyPersona } from "./create-persona.ts";
import type { WriteSink } from "../lib/io.ts";
import {
  listPersonaDirs,
  writeAutostartPersonas,
} from "../lib/personaDefault.ts";
import { defaultSyncHeartbeatInstances } from "../lib/systemd.ts";
import type { PersonaTone } from "../lib/personaTemplate.ts";

export interface RunPersonaNewInput {
  name: string;
  /** Harness id to record as the persona's chain head. */
  harness?: string;
  autostart?: boolean;
  makeDefault?: boolean;
  /** One-line "who is this" for IDENTITY.md. */
  identity?: string;
  tone?: PersonaTone;
  config?: Config;
  out?: WriteSink;
  err?: WriteSink;
  /** Test seam for the heartbeat-instance sync (#486). */
  syncHeartbeatInstances?: (personas: string[]) => Promise<unknown>;
}

/** Persona directory names must survive being a directory name. */
export function validPersonaName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/.test(name);
}

export async function runPersonaNew(
  input: RunPersonaNewInput,
): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const name = input.name?.trim();

  if (!name || !validPersonaName(name)) {
    err.write(
      "phantombot persona new: name must be lowercase letters, digits, '-' or '_', " +
        "and start with a letter or digit\n",
    );
    return 2;
  }

  const config = input.config ?? (await loadConfig());
  if (listPersonaDirs(config).includes(name)) {
    err.write(`phantombot persona new: '${name}' already exists\n`);
    return 2;
  }

  const result = await applyPersona(config, {
    name,
    identity: input.identity ?? `a phantom called ${name}`,
    tone: input.tone ?? "professional",
    expertise: [],
    hardRules: "",
    greeting: "",
    setDefault: input.makeDefault === true,
  });

  if (input.autostart) {
    const list = await writeAutostartPersonas(config, [
      ...(config.autostartPersonas ?? []),
      name,
    ]);
    out.write(`autostart: ${list.join(", ")}\n`);
    // Provision the new persona's heartbeat timer instance right away
    // (#486) — best-effort; the next heartbeat heal reconciles the same
    // state if this fails.
    const sync = input.syncHeartbeatInstances ?? defaultSyncHeartbeatInstances;
    try {
      await sync(
        servedPersonasOf({
          defaultPersona: config.defaultPersona,
          autostartPersonas: list,
        }),
      );
    } catch (e) {
      err.write(
        `warning: could not provision the heartbeat timer instance: ${(e as Error).message}\n`,
      );
    }
  }

  out.write(`created ${result.name} at ${result.dir}\n`);
  if (result.setDefault) {
    out.write(`${name} is now the default persona — it owns /update and /restart\n`);
  } else if (result.adoptedAsDefault) {
    out.write(
      `${name} was adopted as the default persona because the configured default had no directory\n`,
    );
  }
  // A new phantom needs a restart to get its listeners, and the caller should
  // be told rather than left to discover it.
  out.write("run `phantombot restart` to start its channels\n");
  return 0;
}

export default defineCommand({
  meta: {
    name: "new",
    description:
      "Create a persona non-interactively. Does not become the default unless --default is passed.",
  },
  args: {
    name: {
      type: "positional",
      required: true,
      description: "Persona name (lowercase, no spaces).",
    },
    harness: {
      type: "string",
      description: "Harness to think with: claude, codex or pi.",
    },
    autostart: {
      type: "boolean",
      description: "Start this persona's channels at boot.",
      default: false,
    },
    default: {
      type: "boolean",
      description:
        "Make this the default persona. Moves ownership of /update and /restart.",
      default: false,
    },
    identity: {
      type: "string",
      description: 'One-line description: "a senior engineer who…".',
    },
  },
  async run({ args }) {
    process.exitCode = await runPersonaNew({
      name: String(args.name ?? ""),
      harness: args.harness ? String(args.harness) : undefined,
      autostart: Boolean(args.autostart),
      makeDefault: Boolean(args.default),
      identity: args.identity ? String(args.identity) : undefined,
    });
  },
});
