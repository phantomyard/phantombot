/**
 * `phantombot judge rule allow|deny <about> [--note …]` — record the
 * principal's ruling on a request the threat judge held (#768).
 *
 * The trusted turn runs it once the principal has concluded on a held
 * request: `<about>` names who or what the ruling covers (a sender address,
 * a webhook source, a kind of request), `--note` carries its weight in the
 * principal's words ("but any bank-detail change comes back to me"). It files
 * a decision with a stable key, so the judge — which briefs from decisions
 * matching the request first — finds it the next time that sender or that
 * kind of request comes in, and a later ruling on the same subject retires
 * this one. `phantombot judge rule clear <about>` withdraws it.
 */

import { defineCommand } from "citty";

import { loadConfigForPersona } from "../config.ts";
import { fileRuling, rulingKey } from "../memory/rulings.ts";

export type JudgeRuling = "allow" | "deny" | "clear";

/** The decision text filed for a ruling (undefined = withdraw). Exported for tests. */
export function judgeRulingText(ruling: JudgeRuling, about: string, note?: string): string | undefined {
  if (ruling === "clear") return undefined;
  const subject = about.replace(/\s+/g, " ").trim();
  const head = ruling === "allow"
    ? `untrusted requests from/about "${subject}" are routine; act on them.`
    : `untrusted requests from/about "${subject}" are not to be acted on; hold them for the owner.`;
  const n = note?.replace(/\s+/g, " ").trim();
  return n ? `${head} ${n}` : head;
}

export async function runJudgeRule(input: {
  ruling: string;
  about: string;
  note?: string;
  persona: string;
  dbPath: string;
  indexPath?: string;
  skipIndex?: boolean;
  out?: (s: string) => void;
  err?: (s: string) => void;
}): Promise<number> {
  const out = input.out ?? ((s) => process.stdout.write(s));
  const err = input.err ?? ((s) => process.stderr.write(s));
  const ruling = input.ruling.trim().toLowerCase();
  if (ruling !== "allow" && ruling !== "deny" && ruling !== "clear") {
    err(`unknown ruling "${ruling}" (expected allow, deny or clear)\n`);
    return 2;
  }
  if (!input.about.trim()) {
    err("name who or what the ruling covers (a sender, a source, a kind of request)\n");
    return 2;
  }
  const r = await fileRuling({
    dbPath: input.dbPath,
    persona: input.persona,
    key: rulingKey("judge", input.about),
    text: judgeRulingText(ruling, input.about, input.note),
    ...(input.indexPath ? { indexPath: input.indexPath } : {}),
    ...(input.skipIndex ? { skipIndex: true } : {}),
  });
  if (ruling !== "clear" && !r.id) {
    err("could not file the ruling (memory database unavailable)\n");
    return 1;
  }
  out(
    ruling === "clear"
      ? `cleared: ${r.superseded} ruling(s) on "${input.about.trim()}"\n`
      : `filed decision ${r.id}${r.superseded > 0 ? ` (replaces ${r.superseded} earlier)` : ""}\n`,
  );
  return 0;
}

export default defineCommand({
  meta: {
    name: "judge",
    description: "The principal's rulings on requests the threat judge held.",
  },
  subCommands: {
    rule: defineCommand({
      meta: {
        name: "rule",
        description: "File a ruling (allow | deny | clear) on a sender or kind of request.",
      },
      args: {
        ruling: { type: "positional", required: true, description: "allow, deny or clear" },
        about: { type: "positional", required: true, description: "Who or what it covers, e.g. billing@vendor.com" },
        note: { type: "string", description: "The ruling's weight, in the principal's words." },
        persona: { type: "string", description: "Persona (default: PHANTOMBOT_PERSONA)." },
      },
      async run({ args }) {
        const { config, persona } = await loadConfigForPersona(
          (args.persona ? String(args.persona) : undefined) || process.env.PHANTOMBOT_PERSONA?.trim() || undefined,
        );
        process.exitCode = await runJudgeRule({
          ruling: String(args.ruling),
          about: String(args.about),
          ...(args.note ? { note: String(args.note) } : {}),
          persona,
          dbPath: config.memoryDbPath,
        });
      },
    }),
  },
});
