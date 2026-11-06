/**
 * `phantombot escort allow|revoke|list` — the principal's answer to an escort
 * hold notice ("🔒 Held in scheduled task 12: push code to a repository.
 * Allow this in background tasks next time? Reply "allow push".").
 *
 * The trusted turn runs `phantombot escort allow push` when the principal
 * replies "allow push". From then on the escort's briefing carries a ruling
 * that background tasks may do that kind of action when their task calls for
 * it — context for the decision model, never a bypass: it still asks whether
 * each action fits its task. The escort refuses any escorted action that
 * touches these allowances, so the turn being escorted cannot grant itself one.
 */

import { defineCommand } from "citty";

import { loadConfigForPersona, personaDir } from "../config.ts";
import {
  ESCORT_ACTION_KINDS,
  isEscortAllowKind,
  readEscortAllowances,
  setEscortAllowance,
} from "../lib/escort.ts";

async function resolveDir(explicit?: string): Promise<string> {
  const { config, persona } = await loadConfigForPersona(
    explicit || process.env.PHANTOMBOT_PERSONA?.trim() || undefined,
  );
  return personaDir(config, persona);
}

function kindsHelp(): string {
  return Object.entries(ESCORT_ACTION_KINDS)
    .map(([k, v]) => `  ${k.padEnd(8)} ${v}`)
    .join("\n");
}

const personaArg = {
  persona: { type: "string" as const, description: "Persona (default: PHANTOMBOT_PERSONA)." },
};

function kindCommand(name: "allow" | "revoke", allow: boolean) {
  return defineCommand({
    meta: {
      name,
      description: allow
        ? "Let background tasks do this kind of action when their task calls for it."
        : "Remove an allowance; the escort judges that kind of action unbriefed again.",
    },
    args: {
      kind: { type: "positional", required: true, description: "push, review, comment, … (see `escort list`)" },
      ...personaArg,
    },
    async run({ args }) {
      const kind = String(args.kind).trim().toLowerCase();
      if (!isEscortAllowKind(kind)) {
        process.stderr.write(`unknown kind "${kind}". Kinds:\n${kindsHelp()}\n`);
        process.exitCode = 2;
        return;
      }
      setEscortAllowance(await resolveDir(args.persona ? String(args.persona) : undefined), kind, allow);
      process.stdout.write(
        allow
          ? `allowed: background tasks may ${ESCORT_ACTION_KINDS[kind]} when their task calls for it\n`
          : `revoked: ${kind}\n`,
      );
    },
  });
}

export default defineCommand({
  meta: {
    name: "escort",
    description: "The principal's allowances for actions the escort holds in background tasks.",
  },
  subCommands: {
    allow: kindCommand("allow", true),
    revoke: kindCommand("revoke", false),
    list: defineCommand({
      meta: { name: "list", description: "Show current allowances and every kind." },
      args: personaArg,
      async run({ args }) {
        const allowed = readEscortAllowances(await resolveDir(args.persona ? String(args.persona) : undefined));
        process.stdout.write(
          `allowed: ${allowed.length > 0 ? allowed.join(", ") : "(none)"}\nkinds:\n${kindsHelp()}\n`,
        );
      },
    }),
  },
});
