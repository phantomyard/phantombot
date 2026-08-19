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
 * environment so a claim is attributable to the turn that made it. The turn id
 * is load-bearing, not bookkeeping: this CLI exits milliseconds after it writes
 * the lock, so the turn — looked up in the #404 registry — is the only thing
 * still alive to hold it. It is also what lets `unlock` refuse to drop a lock
 * the caller never took, and what lets the orchestrator show a sibling's claims
 * in the prompt.
 *
 * A lock taken from a plain shell has no turn id. That is supported, and means
 * "held until someone unlocks it (or an hour passes)" — see lib/workspaceLock.ts.
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
          // Contention is a DIFFERENT answer from "held", and saying so matters:
          // held means go elsewhere, contended means two claims raced and the
          // same command a moment later will get a truthful held/free answer.
          process.stderr.write(
            result.reason === "contended"
              ? `another turn is claiming ${String(args.path)} right now — retry once, then use a different directory\n`
              : `workspace ${result.heldBy.workspace} is held by ${result.heldBy.conversation} ` +
                  `since ${result.heldBy.acquired_at}` +
                  (result.heldBy.purpose ? ` (${result.heldBy.purpose})` : "") +
                  `\nUse a different directory — do not wait, and do not write here.\n`,
          );
          process.exitCode = 1;
          return;
        }
        if (!result.recorded) {
          // Fail-open, stated honestly. `ok` here means "go ahead and work",
          // NOT "the claim is on disk": either locking is switched off or the
          // state directory would not take the write, and in both cases no
          // other turn can see this claim. Printing `locked` would be a false
          // assurance - the caller would believe it followed the protocol and
          // stop watching for the collision this command exists to prevent.
          // Exit stays 0: a broken state file must not stop the actual work.
          process.stderr.write(
            (result.unrecorded === "disabled"
              ? `workspace locking is switched off (PHANTOMBOT_WORKSPACE_LOCKS)`
              : `could not record the claim — the lock directory is unwritable`) +
              `: ${result.record.workspace} is NOT claimed and no other turn can see it.\n` +
              `Proceeding WITHOUT protection — check for other turns before you write here.\n`,
          );
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
        const result = releaseWorkspace(String(args.path), {
          turnId: callerTurnId(),
          force: Boolean(args.force),
        });
        if (!result.ok) {
          // Three different answers, and conflating them would send the caller
          // the wrong way. "contended" means try again in a moment; "not-owner"
          // means this was never yours to drop (the no-turn-id case too — a
          // claim made by a turn is not something a bare shell gets to release
          // by accident); "failed" is a broken state dir, not a live holder.
          process.stderr.write(
            result.reason === "contended"
              ? `another turn is claiming or releasing ${String(args.path)} right now — retry once\n`
              : result.reason === "failed"
                ? `could not remove the lock for ${String(args.path)} — the lock directory is unwritable; the claim expires on its own when the holding turn ends\n`
                : `refusing to unlock ${String(args.path)}: it is held by ${result.heldBy.conversation} ` +
                  `since ${result.heldBy.acquired_at} (use --force to override)\n`,
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
