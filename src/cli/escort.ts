/**
 * `phantombot escort allow|deny|revoke|list` — the principal's answer to an
 * escort hold notice ("🔒 Held in scheduled task 12: push code to a
 * repository. Allow this in background tasks next time? Reply "allow push",
 * or "deny push" to stop asking.").
 *
 * The trusted turn runs `phantombot escort allow push` when the principal
 * replies "allow push", `escort deny push` for "deny push". An allow rides in
 * the escort's briefing as context, never a bypass: the decision model still
 * asks whether each action fits its task. A deny is enforced in code: an
 * escorted action of that kind is refused without asking the model, and the
 * kind is not asked about again. Every ruling is also filed as a decision (#768), so
 * the judge and the standing memory see it too, and a later ruling on the
 * same kind retires the earlier one.
 *
 * The escort refuses escorted actions that mention these rulings (the obvious
 * spellings). The file is writable by the escorted turn, so that guard is not
 * a boundary: a forged allow only informs the escort's judgement, and the
 * deny list a turn runs under is fixed by the orchestrator before it starts.
 */

import { defineCommand } from "citty";

import { loadConfigForPersona, personaDir } from "../config.ts";
import {
  ESCORT_ACTION_KINDS,
  type EscortAllowKind,
  isEscortAllowKind,
  readEscortRulings,
  setEscortRuling,
} from "../lib/escort.ts";
import { fileRuling, rulingKey } from "../memory/rulings.ts";

async function resolve(explicit?: string): Promise<{ dir: string; persona: string; dbPath: string }> {
  const { config, persona } = await loadConfigForPersona(
    explicit || process.env.PHANTOMBOT_PERSONA?.trim() || undefined,
  );
  return { dir: personaDir(config, persona), persona, dbPath: config.memoryDbPath };
}

function kindsHelp(): string {
  return Object.entries(ESCORT_ACTION_KINDS)
    .map(([k, v]) => `  ${k.padEnd(8)} ${v}`)
    .join("\n");
}

const personaArg = {
  persona: { type: "string" as const, description: "Persona (default: PHANTOMBOT_PERSONA)." },
};

type Ruling = "allow" | "deny" | "clear";

/** The decision text filed for a ruling (undefined = withdraw). Exported for tests. */
export function escortRulingText(kind: EscortAllowKind, ruling: Ruling): string | undefined {
  const what = ESCORT_ACTION_KINDS[kind];
  if (ruling === "allow") return `background tasks may ${what} (escort kind "${kind}") when their task calls for it.`;
  if (ruling === "deny") return `background tasks should not ${what} (escort kind "${kind}") on their own; keep holding it.`;
  return undefined;
}

/** Record one ruling: the escort's file first (its source of truth), then the decision. */
export async function runEscortRuling(input: {
  kind: string;
  ruling: Ruling;
  dir: string;
  persona: string;
  dbPath: string;
  indexPath?: string;
  skipIndex?: boolean;
  out?: (s: string) => void;
  err?: (s: string) => void;
}): Promise<number> {
  const out = input.out ?? ((s) => process.stdout.write(s));
  const err = input.err ?? ((s) => process.stderr.write(s));
  const kind = input.kind.trim().toLowerCase();
  if (!isEscortAllowKind(kind)) {
    err(`unknown kind "${kind}". Kinds:\n${kindsHelp()}\n`);
    return 2;
  }
  setEscortRuling(input.dir, kind, input.ruling);
  await fileRuling({
    dbPath: input.dbPath,
    persona: input.persona,
    key: rulingKey("escort", kind),
    text: escortRulingText(kind, input.ruling),
    ...(input.indexPath ? { indexPath: input.indexPath } : {}),
    ...(input.skipIndex ? { skipIndex: true } : {}),
  });
  out(
    input.ruling === "allow"
      ? `allowed: background tasks may ${ESCORT_ACTION_KINDS[kind]} when their task calls for it\n`
      : input.ruling === "deny"
        ? `denied: background tasks keep holding "${ESCORT_ACTION_KINDS[kind]}", and I stop asking\n`
        : `revoked: ${kind}\n`,
  );
  return 0;
}

function kindCommand(name: "allow" | "deny" | "revoke", ruling: Ruling, description: string) {
  return defineCommand({
    meta: { name, description },
    args: {
      kind: { type: "positional", required: true, description: "push, review, comment, … (see `escort list`)" },
      ...personaArg,
    },
    async run({ args }) {
      const r = await resolve(args.persona ? String(args.persona) : undefined);
      process.exitCode = await runEscortRuling({ kind: String(args.kind), ruling, ...r });
    },
  });
}

export default defineCommand({
  meta: {
    name: "escort",
    description: "The principal's rulings on actions the escort holds in background tasks.",
  },
  subCommands: {
    allow: kindCommand("allow", "allow", "Let background tasks do this kind of action when their task calls for it."),
    deny: kindCommand("deny", "deny", "Keep holding this kind of action in background tasks, and stop asking."),
    revoke: kindCommand("revoke", "clear", "Remove a ruling; the escort judges that kind of action unbriefed again."),
    list: defineCommand({
      meta: { name: "list", description: "Show current rulings and every kind." },
      args: personaArg,
      async run({ args }) {
        const { dir } = await resolve(args.persona ? String(args.persona) : undefined);
        const r = readEscortRulings(dir);
        process.stdout.write(
          `allowed: ${r.allow.length > 0 ? r.allow.join(", ") : "(none)"}\n` +
            `denied:  ${r.deny.length > 0 ? r.deny.join(", ") : "(none)"}\nkinds:\n${kindsHelp()}\n`,
        );
      },
    }),
  },
});
