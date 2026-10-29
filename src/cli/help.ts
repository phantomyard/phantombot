/**
 * Root help for `phantombot` and `phantombot --help`.
 *
 * Citty's stock renderer prints one alphabetical monospace wall: a USAGE line
 * that repeats every command separated by pipes, then each command padded to
 * the terminal's full width. On first contact that reads as noise, and the
 * cluttered USAGE line is the first thing a new user sees.
 *
 * This renderer groups the surface by the job the user has, aligns names in a
 * fixed column, and wraps each description to the terminal. The descriptions
 * themselves come from each command's `meta.description` — one source of truth,
 * so `phantombot acp --help` and the root list can never disagree — and the
 * contract test in tests/cli-help.test.ts holds every one of them to a single
 * short line (<= 20 words), which is what keeps the list scannable as the
 * surface grows.
 *
 * The grouping table is the guard against silent omission: a command wired
 * into the dispatcher but missing from HELP_GROUPS fails that test instead of
 * quietly disappearing from `--help`.
 */

import type { CommandDef } from "citty";
import { resolve } from "../lib/completion.ts";

/** One section of the root help, in display order. */
export interface HelpGroup {
  readonly title: string;
  readonly commands: readonly string[];
}

/**
 * The command surface, grouped by intent. Every key of
 * `mainCommand.subCommands` must appear exactly once across these groups
 * (enforced by the help contract test).
 */
export const HELP_GROUPS: readonly HelpGroup[] = [
  {
    title: "GET STARTED",
    commands: ["persona", "init", "harness", "decision-model", "jev"],
  },
  {
    title: "CHANNELS",
    commands: ["telegram", "phantomchat", "p2p", "voice", "notify", "reply-mode"],
  },
  {
    title: "EDITORS & SCRIPTS",
    commands: ["acp", "ask"],
  },
  {
    title: "SERVICE",
    commands: ["install", "start", "stop", "restart", "run", "logs", "uninstall"],
  },
  {
    title: "MEMORY",
    commands: ["memory", "embedding", "heartbeat", "nightly", "doctor"],
  },
  {
    title: "WORK",
    commands: ["task", "tick", "workspace"],
  },
  {
    title: "SECRETS & TOOLS",
    commands: ["vault", "env", "mcp"],
  },
  {
    title: "MAINTAIN",
    commands: ["update", "fix-signing", "backfill-identity"],
  },
];

/** The clients the perimeter treats as trusted, shown in the footer. */
const TRUSTED_CLIENTS =
  "Telegram, PhantomChat, terminal, VS Code, Zed, JetBrains, OpenCode";

const USAGE: ReadonlyArray<readonly [string, string]> = [
  ["phantombot", "open the terminal app"],
  ["phantombot <command>", "run one command"],
  ["phantombot <command> --help", "flags and subcommands"],
];

const INDENT = "  ";

/**
 * Greedy word wrap. `width` is the column budget for one line; continuation
 * lines are the caller's business (this returns bare lines).
 */
export function wrapText(text: string, width: number): string[] {
  const budget = Math.max(20, width);
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= budget) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Resolve the name + description of every top-level command. */
async function collectCommands(
  root: CommandDef,
): Promise<Map<string, { name: string; description: string }>> {
  const subs = (await resolve(root.subCommands)) ?? {};
  const out = new Map<string, { name: string; description: string }>();
  for (const [key, entry] of Object.entries(subs)) {
    const command = (await resolve(entry)) as CommandDef | undefined;
    const meta = (await resolve(command?.meta)) ?? {};
    out.set(key, {
      name: meta.name ?? key,
      description: (meta.description ?? "").trim(),
    });
  }
  return out;
}

/**
 * Render the root help. Pure apart from reading the live command tree, so a
 * test can pin the layout at a fixed width.
 */
export async function renderRootHelp(
  root: CommandDef,
  options: { columns?: number; version?: string; groups?: readonly HelpGroup[] } = {},
): Promise<string> {
  const width = Math.min(Math.max(options.columns ?? 80, 60), 100);
  const groups = options.groups ?? HELP_GROUPS;
  const commands = await collectCommands(root);
  const meta = (await resolve(root.meta)) ?? {};

  const lines: string[] = [];

  // Header: name + version, then the tagline wrapped under it.
  const version = options.version ?? meta.version;
  lines.push(`${meta.name ?? "phantombot"}${version ? ` v${version}` : ""}`);
  const tagline = meta.description?.trim();
  if (tagline) {
    for (const line of wrapText(tagline, width - INDENT.length)) {
      lines.push(`${INDENT}${line}`);
    }
  }

  // Usage — three shapes, not a pipe-separated list of every command.
  const usageColumn = Math.max(...USAGE.map(([form]) => form.length)) + 2;
  lines.push("", "USAGE");
  for (const [form, note] of USAGE) {
    lines.push(`${INDENT}${form.padEnd(usageColumn)}${note}`);
  }

  // Groups: names aligned once across the whole surface so the eye can run
  // down a single description column.
  const nameColumn =
    Math.max(...groups.flatMap((g) => g.commands.map((c) => c.length))) + 2;
  const descriptionWidth = width - INDENT.length - nameColumn;

  for (const group of groups) {
    const rows = group.commands
      .map((key) => ({ key, ...(commands.get(key) ?? { name: key, description: "" }) }))
      .filter((row) => row.description);
    if (rows.length === 0) continue;
    lines.push("", group.title);
    for (const row of rows) {
      const [first, ...rest] = wrapText(row.description, descriptionWidth);
      lines.push(`${INDENT}${row.key.padEnd(nameColumn)}${first ?? ""}`);
      for (const line of rest) {
        lines.push(`${INDENT}${" ".repeat(nameColumn)}${line}`);
      }
    }
  }

  const footer = [
    "`phantombot <command> --help` lists every flag; a command with subcommands also answers `phantombot <command> <sub> --help`.",
    `Trusted clients: ${TRUSTED_CLIENTS}.`,
  ];
  for (const paragraph of footer) {
    lines.push("");
    for (const line of wrapText(paragraph, width - INDENT.length)) {
      lines.push(`${INDENT}${line}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
