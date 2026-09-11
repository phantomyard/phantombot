/**
 * The Doctor screen's checklist, as DATA.
 *
 * The screen used to render four of the report's checks — telegram, the memory
 * DB, the nightly sweep and its backlog — and drop the rest on the floor.
 * Everything else `runDoctor` computes (systemd units, timer staleness,
 * per-persona maintenance, the default persona, harness binaries, the Pi
 * extension, ACP editor registrations, MCP servers, embeddings, service logs)
 * was visible ONLY in the CLI's text output, so the screen quietly claimed a
 * healthy box while doctor's exit code said otherwise.
 *
 * Telegram was the one substantive channel check, which read as a leftover
 * precisely BECAUSE it was alone. The fix is to add its siblings, not to
 * remove it (Andrew, 2026-09-12).
 *
 * Three rules, which is the whole design:
 *
 *   1. GROUPED — Core, Channels, Integrations. A flat wall of green ticks is
 *      as unreadable as no output; a section heading is what makes "20 checks
 *      passed" skimmable.
 *   2. ONE LINE per check when healthy. `detail` is a value worth reading at a
 *      glance (a size, a version, a count), never a sentence.
 *   3. `hint` — the "here is what to do" line — appears ONLY on a check that
 *      is not green. Failures are loud; health is quiet.
 *
 * `warn` must never read as `bad`. "No Telegram account" is a perfectly good
 * state for a phantom that does not use Telegram, and an operator who learns
 * that yellow means nothing stops reading red too.
 *
 * Doctor REPAIRS as well as reports, so where a check healed something the
 * line says so ("re-stamped", "re-armed") rather than just showing green —
 * otherwise a self-healed fault is indistinguishable from one that never
 * happened, and the operator loses the fact that something was wrong.
 *
 * This is a pure function of the report: no probing, no reading the disk. The
 * screen renders what it returns, so the CLI and the TUI cannot disagree about
 * the health of the same box.
 */

import type { DoctorReport } from "../cli/doctor.ts";
import { missingHarnesses } from "../lib/harnessAvailability.ts";
import { editorConnectorBroken } from "../connectors/acp/autoInstall.ts";
import { humanBytes } from "./theme.ts";

export type CheckState = "ok" | "warn" | "bad";

export interface ChecklistItem {
  label: string;
  state: CheckState;
  /** A value worth a glance. Shown in every state. */
  detail?: string;
  /** What to do about it. Shown only when `state` is not "ok". */
  hint?: string;
}

export interface ChecklistSection {
  title: string;
  items: ChecklistItem[];
}

/** `3` → `3 personas`, `1` → `1 persona`. */
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function coreItems(r: DoctorReport): ChecklistItem[] {
  const items: ChecklistItem[] = [];

  items.push({
    label: "memory database",
    state: r.memory_db.healthy ? "ok" : "bad",
    detail: `${humanBytes(r.memory_db.bytes)} · ${plural(r.memory_db.restore_points.length, "restore point")}`,
    ...(r.memory_db.healthy
      ? {}
      : {
          hint: r.memory_db.newest_good
            ? `${r.memory_db.detail} — newest good snapshot ${r.memory_db.newest_good}; restore with \`phantombot memory backup\``
            : `${r.memory_db.detail} — no verified snapshot to restore from`,
        }),
  });

  if (r.memory_db.unretired_drawers.length > 0)
    items.push({
      label: "drawer files",
      state: "warn",
      detail: plural(r.memory_db.unretired_drawers.length, "file") + " still on disk",
      hint: `retirement held back ${r.memory_db.unretired_drawers.join(", ")} — nothing reads them`,
    });

  items.push({
    label: "nightly sweep",
    state:
      r.nightly.health === "ok"
        ? "ok"
        : r.nightly.health === "error"
          ? "bad"
          : "warn",
    detail: r.nightly.detail,
    ...(r.nightly.health === "ok"
      ? {}
      : {
          hint:
            r.nightly.errors && r.nightly.errors.length > 0
              ? r.nightly.errors.join("; ")
              : "the sweep distils the day into the drawers and kb/ — a backlog means none of that happened",
        }),
  });

  // Backlog is the nightly's only real truth, and it is its own line because a
  // missed 02:00 with nothing pending is still `ok` on the line above.
  if (r.nightly.backlog > 0)
    items.push({
      label: "nightly backlog",
      state: "warn",
      detail: `${plural(r.nightly.backlog, "day")} pending${r.nightly.oldest_pending ? `, oldest ${r.nightly.oldest_pending}` : ""}`,
      hint: "the next sweep catches up on its own; it only needs chasing if this number keeps growing",
    });

  items.push({
    label: "capture",
    state: r.capture.dry_day ? "warn" : "ok",
    detail: `${r.capture.captures} from ${plural(r.capture.user_turns, "turn")} in ${r.capture.window_hours}h`,
    ...(r.capture.dry_day
      ? {
          hint: "turns but no captures — nothing from today will reach the drawers or MEMORY.md",
        }
      : {}),
  });

  if (r.timers) {
    // Not `systemctl is-active`: what each timer last WROTE TO DISK. A timer
    // systemd swears is active but has not fired is the long-uptime failure
    // this catches, and the only evidence is the marker.
    for (const [label, t] of [
      ["heartbeat timer", r.timers.heartbeat],
      ["tick timer", r.timers.tick],
    ] as const)
      items.push({
        label,
        state: t.stale ? "warn" : "ok",
        detail:
          t.last_fired === undefined
            ? "never fired"
            : `fired ${t.age_minutes}m ago`,
        ...(t.stale
          ? {
              hint: `no marker newer than ${t.threshold_minutes}m — doctor re-arms it; systemd can report a timer active while it has stopped firing`,
            }
          : {}),
      });
  }

  if (r.systemd) {
    const broken = [
      ...r.systemd.missing_unit_files,
      ...r.systemd.drifted_unit_files,
      ...r.systemd.inactive_timers,
    ];
    items.push({
      label: "systemd units",
      state: broken.length === 0 ? "ok" : r.systemd.repaired ? "warn" : "bad",
      detail:
        broken.length === 0
          ? "all present and armed"
          : r.systemd.repaired
            ? `repaired ${plural(broken.length, "unit")}`
            : `${plural(broken.length, "unit")} broken`,
      ...(broken.length === 0
        ? {}
        : {
            hint: r.systemd.repaired
              ? `re-rendered / re-armed: ${broken.join(", ")}`
              : `${broken.join(", ")} — run \`phantombot doctor\` without --no-repair`,
          }),
    });
  }

  if (r.maintenance) {
    // One line for the fleet when it is fine, one line per persona when it is
    // not: a per-persona list on a healthy box is four lines saying nothing.
    const behind = r.maintenance.filter(
      (m) => m.heartbeat_stale || m.nightly_backlog > 0,
    );
    if (behind.length === 0)
      items.push({
        label: "persona maintenance",
        state: "ok",
        detail: `${plural(r.maintenance.length, "persona")} current`,
      });
    else
      for (const m of behind)
        items.push({
          label: `maintenance: ${m.persona}`,
          state: "warn",
          detail: m.heartbeat_stale
            ? m.last_heartbeat === undefined
              ? "heartbeat never fired"
              : `heartbeat ${m.heartbeat_age_minutes}m ago`
            : `nightly ${plural(m.nightly_backlog, "date")} pending`,
          hint: `check \`systemctl --user status phantombot-heartbeat@${m.persona}.timer\``,
        });
  }

  const dp = r.default_persona;
  items.push({
    label: "default persona",
    state: dp.healthy ? "ok" : "bad",
    detail: `${dp.resolved} (from ${dp.provenance})`,
    ...(dp.healthy
      ? {}
      : {
          hint:
            dp.defect ??
            (dp.served
              ? dp.detail
              : `${dp.resolved} is the default but is not served — the config contradicts itself`),
        }),
  });

  if (r.service_logs)
    items.push({
      label: "service logs",
      state: r.service_logs.over_cap.length === 0 ? "ok" : "warn",
      detail: `${humanBytes(r.service_logs.bytes)} · cap ${humanBytes(r.service_logs.max_bytes)} × ${r.service_logs.keep}`,
      ...(r.service_logs.over_cap.length === 0
        ? {}
        : {
            hint: `over cap, rotated on the next heartbeat: ${r.service_logs.over_cap.join(", ")}`,
          }),
    });

  items.push({
    label: "release ring",
    state: "ok",
    detail: `${r.update.channel} · v${r.update.version}`,
  });

  return items;
}

function channelItems(r: DoctorReport): ChecklistItem[] {
  const items: ChecklistItem[] = [];

  // Telegram stays, and keeps its per-persona expansion. It answers the one
  // question no other line does: will this phantom actually RECEIVE a message.
  const stated = r.telegram.personas.filter((p) => p.stated);
  items.push({
    label: "telegram",
    state: !r.telegram.healthy ? "bad" : stated.length === 0 ? "warn" : "ok",
    detail:
      stated.length === 0
        ? "no account configured"
        : `${plural(r.telegram.listeners, "listener")} across ${plural(stated.length, "persona")}`,
    ...(r.telegram.healthy
      ? stated.length === 0
        ? {
            hint: "nothing is wrong — this host simply does not answer on Telegram",
          }
        : {}
      : {
          hint: r.telegram.personas
            .filter((p) => !p.healthy)
            .map((p) => `${p.persona}: ${p.detail}`)
            .join("; "),
        }),
  });

  items.push({
    label: "embeddings",
    state: r.embeddings.semantic_search ? "ok" : "warn",
    detail: r.embeddings.semantic_search
      ? `${r.embeddings.provider} · semantic search on`
      : r.embeddings.provider === "none"
        ? "no provider · keyword search only"
        : `${r.embeddings.provider} configured but incomplete`,
    ...(r.embeddings.semantic_search
      ? {}
      : {
          // Explicitly NOT a fault: memory search still works on FTS5/BM25.
          // But a provider that is configured and still off is usually a
          // revoked key, and that degradation is silent.
          hint:
            r.embeddings.provider === "none"
              ? "optional — memory search works on keyword matching without it"
              : "the provider is set but unusable (commonly a revoked or missing API key) — search has silently dropped to keyword-only",
        }),
  });

  return items;
}

function integrationItems(r: DoctorReport): ChecklistItem[] {
  const items: ChecklistItem[] = [];

  if (r.harnesses) {
    const missing = missingHarnesses(r.harnesses.checks);
    items.push({
      label: "harness binaries",
      state: missing.length === 0 ? "ok" : "bad",
      detail:
        missing.length === 0
          ? r.harnesses.checks.map((h) => h.id).join(", ") || "none configured"
          : `${plural(missing.length, "harness", "harnesses")} not found`,
      ...(missing.length === 0
        ? {}
        : {
            // Resolved against the SERVICE path, not an interactive shell —
            // which is the whole point of the check.
            hint: `${missing.map((h) => `${h.id}: '${h.bin}'`).join("; ")} not on the service PATH`,
          }),
    });
  }

  const dp = r.default_persona;
  items.push({
    label: "mcp servers",
    state: dp.mcp_error
      ? "bad"
      : dp.mcp_servers === 0 && dp.mcp_elsewhere.length > 0
        ? "warn"
        : "ok",
    detail: dp.mcp_error
      ? "registry does not load"
      : plural(dp.mcp_servers, "server") + ` for ${dp.resolved}`,
    ...(dp.mcp_error
      ? { hint: dp.mcp_error }
      : dp.mcp_servers === 0 && dp.mcp_elsewhere.length > 0
        ? {
            // The exact shape of a migrated-away default: this persona has
            // none while another does.
            hint: `${dp.resolved} has none while ${dp.mcp_elsewhere.join(", ")} does — check the default persona is the one you meant`,
          }
        : {}),
  });

  if (r.piExtension) {
    const p = r.piExtension;
    const ok = p.shouldExist
      ? p.present && (!p.drifted || !!p.repaired)
      : !p.present || !!p.repaired;
    items.push({
      label: "pi extension",
      state: ok ? "ok" : "bad",
      detail: !p.shouldExist
        ? p.present
          ? "present but not wanted"
          : "correctly absent"
        : p.repaired
          ? p.present
            ? "re-stamped"
            : "stamped"
          : p.drifted
            ? "drifted"
            : "present and current",
      ...(ok
        ? {}
        : {
            hint: `${p.dir} — run \`phantombot doctor\` to ${p.shouldExist ? "re-stamp" : "remove"} it`,
          }),
    });
  }

  // ACP editor connectors. An absent editor is not a fault, so it is `ok`
  // with "not installed" rather than a yellow row on every headless box.
  //
  // `editorConnectorBroken` decides the COLOUR because it also decides
  // doctor's exit code — a screen that painted a non-zero exit green would be
  // the same class of bug this file replaced. The individual flags only choose
  // the hint's WORDING: a registration failure and a missing proposed-api
  // allow-list are both red, and telling them apart is the whole value of the
  // hint row.
  for (const e of r.editorConnectors ?? []) {
    const registrationBroken = e.action === "error" || e.action === "stale";
    const proposedBroken = e.proposedApi === "stale" || e.proposedApi === "error";
    items.push({
      label: `acp: ${e.editor}`,
      state: editorConnectorBroken(e) ? "bad" : "ok",
      detail:
        e.action === "not-detected"
          ? "not installed on this machine"
          : e.action === "current"
            ? "registered and current"
            : e.action,
      ...(registrationBroken
        ? {
            hint: `${e.settingsPath}${e.error ? ` — ${e.error}` : " — run `phantombot doctor` without --no-repair"}`,
          }
        : proposedBroken
          ? {
              hint:
                e.proposedApi === "stale"
                  ? "not allow-listed in ~/.vscode/argv.json — falls back to the `@phantombot` participant instead of a native chat session; run `phantombot doctor` without --no-repair"
                  : `proposed-api could not be allow-listed${e.proposedApiError ? ` — ${e.proposedApiError}` : ""}`,
            }
          : {}),
    });
  }

  return items;
}

/**
 * The whole checklist, in display order. Empty sections are dropped: a macOS
 * box has no systemd, a headless box no editors, and a heading over nothing
 * reads as a check that failed to run.
 */
export function doctorChecklist(r: DoctorReport): ChecklistSection[] {
  return [
    { title: "CORE", items: coreItems(r) },
    { title: "CHANNELS", items: channelItems(r) },
    { title: "INTEGRATIONS", items: integrationItems(r) },
  ].filter((s) => s.items.length > 0);
}

/** The worst state anywhere in the checklist — the screen's headline verdict. */
export function checklistVerdict(sections: ChecklistSection[]): CheckState {
  const states = sections.flatMap((s) => s.items.map((i) => i.state));
  if (states.includes("bad")) return "bad";
  if (states.includes("warn")) return "warn";
  return "ok";
}
