import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

import type { HostSnapshot } from "./snapshot.ts";
import {
  HEARTBEAT_STALE_MINUTES,
  TICK_STALE_MINUTES,
  loadPersonaHeartbeatLastFired,
  loadTickLastFired,
} from "../lib/timerHealth.ts";

export type SystemState =
  "healthy" | "running" | "delayed" | "failed" | "unavailable";

export interface ServiceMetric {
  id: "daemon" | "heartbeat" | "tick";
  state: SystemState;
  detail: string;
  last?: string;
  next?: string;
  runs?: number;
  failures?: number;
  history: number[];
}

export interface SystemSnapshot {
  services: ServiceMetric[];
  capturedAt: string;
}

function taskSummary(host: HostSnapshot): {
  next?: string;
  failures: number;
  history: number[];
} {
  let next: string | undefined;
  let failures = 0;
  const history: number[] = [];
  for (const persona of host.personas) {
    const path = persona.memory.dbPath;
    if (!existsSync(path)) continue;
    let db: Database | undefined;
    try {
      db = new Database(path, { readonly: true });
      const n = db
        .query("SELECT MIN(next_run_at) AS at FROM tasks WHERE active = 1")
        .get() as { at?: string } | null;
      if (n?.at && (!next || n.at < next)) next = n.at;
      const rows = db
        .query("SELECT status FROM task_runs ORDER BY fired_at DESC LIMIT 12")
        .all() as Array<{ status: string }>;
      failures += rows.filter((r) => r.status === "error").length;
      history.push(...rows.reverse().map((r) => (r.status === "ok" ? 1 : 0)));
    } catch {
      // Missing/old task tables are unavailable data, never a broken TUI.
    } finally {
      db?.close();
    }
  }
  return { next, failures, history: history.slice(-12) };
}

export function systemSnapshot(
  host: HostSnapshot,
  now = new Date(),
): SystemSnapshot {
  const heartbeats = host.personas
    .filter((p) => p.autostart)
    .map((p) =>
      loadPersonaHeartbeatLastFired(p.name, { isDefault: p.isDefault, now }),
    );
  const heartbeatAge = heartbeats.reduce<number | undefined>(
    (oldest, h) =>
      h.ageMinutes === undefined ? oldest : Math.max(oldest ?? 0, h.ageMinutes),
    undefined,
  );
  const heartbeatRuns = heartbeats.reduce((sum, h) => sum + (h.runs ?? 0), 0);
  const heartbeatLast = heartbeats
    .map((h) => h.iso)
    .filter(Boolean)
    .sort()
    .at(0);
  const tick = loadTickLastFired(now);
  const tasks = taskSummary(host);

  return {
    capturedAt: now.toISOString(),
    services: [
      {
        id: "daemon",
        state:
          host.serviceActive === undefined
            ? "unavailable"
            : host.serviceActive
              ? "running"
              : "failed",
        detail:
          host.serviceActive === undefined
            ? "service state unavailable"
            : host.serviceActive
              ? "listener service active"
              : "listener service stopped",
        history: [],
      },
      {
        id: "heartbeat",
        state:
          heartbeatAge === undefined
            ? "unavailable"
            : heartbeatAge > HEARTBEAT_STALE_MINUTES
              ? "delayed"
              : "healthy",
        detail:
          heartbeatAge === undefined
            ? "no fire marker"
            : `${heartbeatAge}m since oldest served persona fired`,
        last: heartbeatLast,
        runs: heartbeatRuns || undefined,
        history: heartbeats.map((h) =>
          h.ageMinutes !== undefined && h.ageMinutes <= HEARTBEAT_STALE_MINUTES
            ? 1
            : 0,
        ),
      },
      {
        id: "tick",
        state:
          tick.ageMinutes === undefined
            ? "unavailable"
            : tick.ageMinutes > TICK_STALE_MINUTES
              ? "delayed"
              : tasks.failures > 0
                ? "failed"
                : "healthy",
        detail:
          tick.ageMinutes === undefined
            ? "no fire marker"
            : `${tick.ageMinutes}m since scheduler fired`,
        last: tick.iso,
        next: tasks.next,
        runs: tick.runs,
        failures: tasks.failures,
        history: tasks.history,
      },
    ],
  };
}
