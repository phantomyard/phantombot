/**
 * Every log stream this host keeps, unified for the TUI's log pane (#478).
 *
 * The pane used to show ONE source: a 100-line, process-local ring fed by the
 * TUI's own logger and, once a chat was open, the harness's stderr. Opening the
 * TUI over SSH purely to look at logs therefore showed `0/0` by construction —
 * the daemon that answers Telegram is a DIFFERENT process, and its lines go to
 * journald (or the launchd/Task Scheduler files), never to this buffer.
 *
 * So this module inverts the design: the pane no longer displays what happened
 * to be captured, it READS the real sinks on demand.
 *
 *   session      the in-process ring (TUI + harness stderr) — still live, still
 *                the only source that updates without a refresh
 *   service      the daemon: journalctl on Linux, the out/err files on
 *                macOS/Windows
 *   audit        the per-persona tool-call audit trail, `<persona>/audit/<day>.log`
 *   state        the append-only persona-switch audit, `state-audit.log`
 *   tasks        `task_runs` rows — every scheduled fire, with its status
 *
 * Two rules hold for all of them:
 *
 *   1. EVERY source reports its `location` — the concrete path, the journald
 *      unit, or the table — and a copy-pasteable `command` for the full,
 *      unfiltered stream. "Where do I find the audit logs?" is answerable from
 *      the screen, which is the question that motivated the issue.
 *   2. A source that cannot be read is `available: false` WITH a reason, and is
 *      still listed. Hiding it would make a missing log indistinguishable from
 *      a quiet one, which is exactly the failure mode #478 was filed for.
 *
 * Reads are bounded (`limit`) and never throw: a log viewer that crashes the
 * terminal because journalctl is absent in a container is worse than one that
 * says so in a row.
 */

import { Database } from "bun:sqlite";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { auditPath } from "../state.ts";
import { logsLocation, logsSpec } from "../lib/platform.ts";
import { logBuffer, parseLogLine, type LogLine } from "./logBuffer.ts";
import type { HostSnapshot, PersonaSnapshot } from "./snapshot.ts";

export type LogSourceId = "session" | "service" | "audit" | "state" | "tasks";

/** Order is the cycle order in the UI: live first, then broadest to narrowest. */
export const LOG_SOURCE_IDS: LogSourceId[] = [
  "session",
  "service",
  "audit",
  "state",
  "tasks",
];

export interface LogSource {
  id: LogSourceId;
  label: string;
  /** Where the bytes live: a path, a journald unit, or a table. Always shown. */
  location: string;
  /** Copy-pasteable command for the full stream, or "" when there is none. */
  command: string;
  /** False means "nothing to read here", and `note` says why. */
  available: boolean;
  note?: string;
  /** Newest last, at most `limit` lines. Never throws. */
  read(limit: number): Promise<LogLine[]>;
}

/** How many lines each source is asked for by default. */
export const DEFAULT_SOURCE_LIMIT = 2000;

function line(
  at: number,
  level: string,
  msg: string,
  type: string,
  persona?: string,
  raw?: string,
): LogLine {
  return { at, level, msg, type, persona, raw: raw ?? msg };
}

/** A single row explaining why a source is empty, so the pane is never blank. */
function unavailable(reason: string, type: string): LogLine[] {
  return [line(Date.now(), "warn", reason, type)];
}

/**
 * The daemon's own log. On Linux this is journald and there is no file; we
 * shell out to the same `logsSpec` argv `phantombot logs` uses, with
 * `follow: false`, so there is exactly one definition of "the service log"
 * in the codebase.
 */
function serviceSource(): LogSource {
  const loc = logsLocation();
  return {
    id: "service",
    label: "service (daemon)",
    location: loc.kind === "journal" ? loc.label : loc.paths.join("  ·  "),
    command: loc.command,
    available: true,
    async read(limit) {
      const spec = logsSpec({ follow: false, lines: limit });
      if (!spec) {
        return unavailable(
          `no log backend on ${process.platform} — see: ${loc.command}`,
          "service",
        );
      }
      try {
        const proc = Bun.spawn([spec.cmd, ...spec.args], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        const parsed = out
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => parseLogLine(l));
        return parsed.length
          ? parsed.slice(-limit)
          : unavailable(`no lines yet — see: ${loc.command}`, "service");
      } catch (err) {
        return unavailable(
          `could not run '${spec.cmd}': ${String(err)} — see: ${loc.command}`,
          "service",
        );
      }
    },
  };
}

/** UTC day stamps, newest first, matching auditLog.ts's file naming. */
function recentDays(now: Date, count: number): string[] {
  const days: string[] = [];
  for (let i = 0; i < count; i++) {
    days.push(
      new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10),
    );
  }
  return days;
}

/**
 * The tool-call audit trail, per persona. This is the one Ronald could not
 * find: `<persona-dir>/audit/<YYYY-MM-DD>.log`, JSON lines written by
 * `lib/auditLog.ts`. We read the whole audit directory rather than only
 * today's file so a pane opened at 00:05 is not empty.
 */
function auditSource(personas: PersonaSnapshot[], now: Date): LogSource {
  const dirs = personas.map((p) => ({ persona: p.name, dir: join(p.dir, "audit") }));
  return {
    id: "audit",
    label: "audit (tool calls)",
    location: dirs.length
      ? dirs.map((d) => `${d.dir}/${recentDays(now, 1)[0]}.log`).join("  ·  ")
      : "(no personas)",
    command: dirs.length ? `tail -f ${dirs[0]!.dir}/*.log` : "",
    available: dirs.length > 0,
    note: dirs.length ? undefined : "no personas on this host",
    async read(limit) {
      const out: LogLine[] = [];
      for (const { persona, dir } of dirs) {
        let names: string[];
        try {
          names = (await readdir(dir)).filter((n) => n.endsWith(".log")).sort();
        } catch {
          continue; // no audit yet for this persona: not an error
        }
        for (const name of names.slice(-3)) {
          let body: string;
          try {
            body = await readFile(join(dir, name), "utf8");
          } catch {
            continue;
          }
          for (const raw of body.split("\n")) {
            if (!raw.trim()) continue;
            let rec: { ts?: string; kind?: string; note?: string; locations?: string[] };
            try {
              rec = JSON.parse(raw) as typeof rec;
            } catch {
              out.push(line(Date.now(), "raw", raw, "audit", persona, raw));
              continue;
            }
            const where = rec.locations?.length ? ` [${rec.locations.join(", ")}]` : "";
            out.push(
              line(
                rec.ts ? Date.parse(rec.ts) : Date.now(),
                "info",
                `${rec.kind ?? "tool"}: ${rec.note ?? ""}${where}`,
                "audit",
                persona,
                raw,
              ),
            );
          }
        }
      }
      out.sort((a, b) => a.at - b.at);
      if (!out.length) {
        return unavailable(
          "no tool calls recorded yet (PHANTOMBOT_AUDIT_TOOL_CALLS may be off)",
          "audit",
        );
      }
      return out.slice(-limit);
    },
  };
}

/** The append-only persona-switch audit written by `saveState`. */
function stateSource(): LogSource {
  const path = auditPath();
  return {
    id: "state",
    label: "state (persona switches)",
    location: path,
    command: `tail -f ${path}`,
    available: true,
    async read(limit) {
      let body: string;
      try {
        body = await readFile(path, "utf8");
      } catch {
        return unavailable(`nothing recorded yet at ${path}`, "state");
      }
      const out = body
        .split("\n")
        .filter((l) => l.trim())
        .map((raw) => {
          const parsed = parseLogLine(raw);
          return { ...parsed, type: "state" };
        });
      return out.length ? out.slice(-limit) : unavailable(`empty: ${path}`, "state");
    },
  };
}

/**
 * Scheduled-task fires. Not a log FILE at all — `task_runs` in each persona's
 * memory DB — which is exactly why it belongs here: it is a stream an operator
 * would otherwise have to know SQL to see.
 */
function taskSource(personas: PersonaSnapshot[]): LogSource {
  const dbs = personas
    .map((p) => ({ persona: p.name, path: p.memory?.dbPath }))
    .filter((d): d is { persona: string; path: string } => Boolean(d.path));
  return {
    id: "tasks",
    label: "tasks (scheduled fires)",
    location: dbs.length
      ? dbs.map((d) => `${d.path} · table task_runs`).join("  ·  ")
      : "(no persona databases)",
    command: dbs.length ? "phantombot task list" : "",
    available: dbs.length > 0,
    note: dbs.length ? undefined : "no persona databases on this host",
    async read(limit) {
      const out: LogLine[] = [];
      for (const { persona, path } of dbs) {
        let db: Database | undefined;
        try {
          db = new Database(path, { readonly: true });
          const rows = db
            .query(
              "SELECT fired_at, status, detail, task_id FROM task_runs ORDER BY fired_at DESC LIMIT ?1",
            )
            .all(limit) as Array<{
            fired_at?: string;
            status?: string;
            detail?: string;
            task_id?: string | number;
          }>;
          for (const r of rows) {
            out.push(
              line(
                r.fired_at ? Date.parse(r.fired_at) : Date.now(),
                r.status === "error" ? "error" : "info",
                `task ${r.task_id ?? "?"} ${r.status ?? "?"}${r.detail ? `: ${r.detail}` : ""}`,
                "tasks",
                persona,
              ),
            );
          }
        } catch {
          // A missing or older table is unavailable data, never a broken pane.
        } finally {
          db?.close();
        }
      }
      out.sort((a, b) => a.at - b.at);
      return out.length ? out.slice(-limit) : unavailable("no task fires recorded", "tasks");
    },
  };
}

/** The live in-process ring: the TUI's own logger plus harness stderr. */
function sessionSource(): LogSource {
  return {
    id: "session",
    label: "session (this TUI)",
    location: "in-memory ring (this TUI process; not persisted)",
    command: "",
    available: true,
    async read(limit) {
      const lines = logBuffer.tail(limit);
      return lines.length
        ? lines
        : unavailable(
            "this TUI process has logged nothing yet — the daemon's own log is the 'service' source",
            "session",
          );
    },
  };
}

/**
 * Stand-in for "this host offers no sources at all". Never returned by
 * {@link logSources} — it exists so the pane has something to render rather
 * than indexing off the end of an empty list, which would crash the terminal.
 */
export const EMPTY_SOURCE: LogSource = {
  id: "session",
  label: "none",
  location: "(no log sources on this host)",
  command: "",
  available: false,
  note: "no log sources",
  read: async () => [],
};

export interface LogSourcesInput {
  host: HostSnapshot;
  now?: Date;
}

/** Every source on this host, in cycle order. Pure: no I/O until `read`. */
export function logSources(input: LogSourcesInput): LogSource[] {
  const now = input.now ?? new Date();
  const personas = input.host.personas;
  const byId: Record<LogSourceId, LogSource> = {
    session: sessionSource(),
    service: serviceSource(),
    audit: auditSource(personas, now),
    state: stateSource(),
    tasks: taskSource(personas),
  };
  return LOG_SOURCE_IDS.map((id) => byId[id]);
}
