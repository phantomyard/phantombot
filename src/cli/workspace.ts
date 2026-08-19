/**
 * `phantombot workspace` — claim, release and inspect shared working copies
 * (issue #405).
 *
 * This is the agent-facing half of `lib/workspaceLock.ts`. A turn about to work
 * in a checkout two turns can both reach (`/tmp/phantombot-inspect` being the
 * concrete case from #391) claims it here first, and releases when done.
 *
 * The claim is ADVISORY — phantombot does not sit in the path of the `git` the
 * harness runs through its own Bash tool, so nothing here can prevent a write.
 * What it provides is a truthful answer to "is anyone else in this tree", which
 * previously did not exist at all.
 *
 * `PHANTOMBOT_TURN_ID` and `PHANTOMBOT_CONVERSATION` are read from the harness
 * environment so a claim is attributable to the turn that made it — that is
 * what lets `release` refuse to drop a lock the caller never took, and what
 * lets the orchestrator show a sibling's claims in the prompt.
 */

import { defineCommand } from "citty";

import {
  acquireWorkspace,
  listWorkspaceLocks,
  releaseWorkspace,
  workspaceHolder,
} from "../lib/workspaceLock.ts";

function callerPersona(explicit?: string): string {
  return explicit || process.env.PHANTOMBOT_PERSONA?.trim() || "default";
}

function callerConversation(): string {
  return process.env.PHANTOMBOT_CONVERSATION?.trim() || "(unknown)";
}

function callerTurnId(): string | undefined {
  return process.env.PHANTOMBOT_TURN_ID?.trim() || undefined;
}

export default defineCommand({
  meta: {
    name: "workspace",
    description:
      "Advisory locks on shared working copies (git checkouts, build trees) so two concurrent turns don't trample each other. Advisory only — it records and reports a claim, it cannot block a write.",
  },
  subCommands: {
    lock: defineCommand({
      meta: {
        name: "lock",
        description:
          "Claim a working copy for this turn. Exits 1 (without waiting) if another live turn holds it — use a different directory rather than blocking.",
      },
      args: {
        path: {
          type: "positional",
          required: true,
          description: "Working copy to claim (e.g. /tmp/phantombot-inspect)",
        },
        purpose: {
          type: "string",
          description: "What you're doing in there, shown to the other turn.",
        },
        persona: { type: "string", description: "Persona making the claim." },
      },
      run({ args }) {
        const result = acquireWorkspace({
          workspace: String(args.path),
          persona: callerPersona(
            args.persona ? String(args.persona) : undefined,
          ),
          conversation: callerConversation(),
          turnId: callerTurnId(),
          purpose: args.purpose ? String(args.purpose) : undefined,
        });
        if (!result.ok) {
          process.stderr.write(
            `workspace ${result.heldBy.workspace} is held by ${result.heldBy.conversation} ` +
              `since ${result.heldBy.acquired_at}` +
              (result.heldBy.purpose ? ` (${result.heldBy.purpose})` : "") +
              `\nUse a different directory — do not wait, and do not write here.\n`,
          );
          process.exitCode = 1;
          return;
        }
        if (result.tookOver) {
          // Worth saying out loud: the previous holder died mid-turn, so the
          // tree may be in a state it never finished (a half-rebase, a dirty
          // index). Better the new holder checks than assumes.
          process.stdout.write(
            `took over ${result.record.workspace} from a dead holder — check the tree is clean\n`,
          );
        }
        process.stdout.write(`locked ${result.record.workspace}\n`);
      },
    }),
    unlock: defineCommand({
      meta: {
        name: "unlock",
        description: "Release a working copy this turn claimed.",
      },
      args: {
        path: {
          type: "positional",
          required: true,
          description: "Working copy to release",
        },
        force: {
          type: "boolean",
          description:
            "Release even if another turn holds it. For clearing a lock by hand; not for normal use.",
        },
      },
      run({ args }) {
        const ok = releaseWorkspace(String(args.path), {
          turnId: callerTurnId(),
          force: Boolean(args.force),
        });
        if (!ok) {
          process.stderr.write(
            `refusing to unlock ${args.path}: it is held by a different turn (use --force to override)\n`,
          );
          process.exitCode = 1;
          return;
        }
        process.stdout.write(`unlocked ${args.path}\n`);
      },
    }),
    status: defineCommand({
      meta: {
        name: "status",
        description:
          "Show live workspace claims. With a path, show just that one.",
      },
      args: {
        path: {
          type: "positional",
          required: false,
          description: "Optional working copy to query",
        },
      },
      run({ args }) {
        if (args.path) {
          const holder = workspaceHolder(String(args.path));
          if (!holder) {
            process.stdout.write(`${args.path} is not locked\n`);
            return;
          }
          process.stdout.write(
            `${holder.workspace} held by ${holder.conversation} since ${holder.acquired_at}` +
              (holder.purpose ? ` (${holder.purpose})` : "") +
              "\n",
          );
          return;
        }
        const locks = listWorkspaceLocks();
        if (locks.length === 0) {
          process.stdout.write("no workspaces locked\n");
          return;
        }
        for (const lock of locks) {
          process.stdout.write(
            `${lock.workspace}\t${lock.persona}\t${lock.conversation}\t${lock.acquired_at}` +
              (lock.purpose ? `\t${lock.purpose}` : "") +
              "\n",
          );
        }
      },
    }),
  },
});
