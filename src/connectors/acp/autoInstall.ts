/**
 * Auto-registration of phantombot as an ACP agent in detected editors.
 *
 * Andrew shouldn't have to run `phantombot acp install zed` (or `… vscode`)
 * by hand. This module detects which supported editors are present on the
 * machine and registers phantombot into each one's settings — idempotently,
 * and with hard error isolation so it can NEVER break phantombot's startup.
 *
 * Two callers wire this in (see run.ts and doctor.ts):
 *   - startup     — fire-and-forget right after the listener is up, so a
 *                   freshly-installed/updated binary registers itself
 *                   immediately (no 30-min wait, no manual command).
 *   - doctor      — repairs/registers on demand AND, with --no-repair, just
 *                   reports drift so the wiring is diagnosable.
 *
 * Idempotency is the whole game: we only WRITE when phantombot is missing
 * from the editor's settings, or registered under a different binary path
 * (e.g. the binary moved or the user installed a newer one). When the
 * registration already points at this exact binary we touch nothing — so
 * running every startup doesn't churn backups or rewrite the user's file.
 *
 * Detection is "the editor's config dir exists". That keeps us from creating
 * config dirs for editors the user doesn't have installed: if `~/.config/zed`
 * isn't there, Zed isn't there, and we skip it.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse } from "jsonc-parser";

import type { WriteSink } from "../../lib/io.ts";
import { defaultZedSettingsPath, installZed } from "./installZed.ts";

/** A sink that drops everything — keeps reconcile silent on stdout/stderr. */
const SILENT: WriteSink = { write: () => true };

export type EditorConnectorAction =
  /** Editor not installed on this machine — nothing to do. */
  | "not-detected"
  /** Already registered with this exact binary path — no write. */
  | "current"
  /** Was absent; we wrote the registration. */
  | "registered"
  /** Was registered under a different binary path; we rewrote it. */
  | "updated"
  /** Needs (re)registration but repair was off — reported, not written. */
  | "stale"
  /** A failure (e.g. unparseable settings ⇒ data-loss guard aborted). */
  | "error";

export interface EditorConnectorResult {
  editor: string;
  action: EditorConnectorAction;
  settingsPath: string;
  error?: string;
}

/**
 * One supported editor. Kept tiny + data-driven so VS Code (PR2) slots in by
 * adding a second entry — the reconcile loop below is editor-agnostic.
 */
export interface EditorSpec {
  id: string;
  /** Resolve this editor's settings.json path. */
  settingsPath(): string;
  /**
   * Directory whose existence signals the editor is present. Defaults to the
   * settings file's parent dir (e.g. ~/.config/zed).
   */
  detectionDir(settingsPath: string): string;
  /** Read the phantombot command currently registered, if any. */
  currentCommand(settingsPath: string): string | undefined;
  /** Perform the idempotent registration write. Returns a 0/1 code. */
  install(binaryPath: string, out?: WriteSink, err?: WriteSink): { code: number };
}

/** Best-effort read of `agent_servers.Phantombot.command` from JSONC settings. */
function readZedCommand(settingsPath: string): string | undefined {
  try {
    const raw = readFileSync(settingsPath, "utf8");
    // Tolerant parse (comments + trailing commas). On a malformed file this
    // returns a best-effort value or undefined; either way installZed re-parses
    // with error collection and aborts safely, so we never risk data loss here.
    const parsed = parse(raw) as
      | { agent_servers?: { Phantombot?: { command?: unknown } } }
      | undefined;
    const cmd = parsed?.agent_servers?.Phantombot?.command;
    return typeof cmd === "string" ? cmd : undefined;
  } catch {
    return undefined;
  }
}

export const ZED_EDITOR: EditorSpec = {
  id: "zed",
  settingsPath: defaultZedSettingsPath,
  detectionDir: (settingsPath) => dirname(settingsPath),
  currentCommand: readZedCommand,
  install: (binaryPath, out, err) => installZed({ binaryPath, out, err }),
};

/** Editors phantombot knows how to register itself into. */
export const KNOWN_EDITORS: EditorSpec[] = [ZED_EDITOR];

export interface ReconcileOptions {
  /** Absolute path to the phantombot binary the editor should spawn. */
  binaryPath: string;
  /** Write when registration is missing/stale. False = report only. Default true. */
  repair?: boolean;
  /** Override the editor list (tests). Default: KNOWN_EDITORS. */
  editors?: EditorSpec[];
  out?: WriteSink;
  err?: WriteSink;
}

/**
 * Detect supported editors and bring each one's phantombot registration in
 * line with `binaryPath`. Per-editor try/catch means one editor's failure
 * never affects the others, and the function as a whole never throws — safe to
 * call fire-and-forget from startup.
 */
export function reconcileEditorConnectors(
  opts: ReconcileOptions,
): EditorConnectorResult[] {
  const repair = opts.repair ?? true;
  const editors = opts.editors ?? KNOWN_EDITORS;
  const results: EditorConnectorResult[] = [];

  for (const editor of editors) {
    let settingsPath = "";
    try {
      settingsPath = editor.settingsPath();

      // Detection: only touch editors actually present on this machine.
      if (!existsSync(editor.detectionDir(settingsPath))) {
        results.push({ editor: editor.id, action: "not-detected", settingsPath });
        continue;
      }

      const current = editor.currentCommand(settingsPath);
      if (current === opts.binaryPath) {
        results.push({ editor: editor.id, action: "current", settingsPath });
        continue;
      }

      const wasRegistered = current !== undefined;

      if (!repair) {
        // Report-only mode (doctor --no-repair): surface the drift, write nothing.
        results.push({ editor: editor.id, action: "stale", settingsPath });
        continue;
      }

      // Silence installZed's own stdout/stderr chatter by default: reconcile is
      // a background/diagnostic path (startup logs via the result; `doctor
      // --json` must emit ONLY JSON on stdout). The manual `acp install zed`
      // command still prints, because it calls installZed directly, not here.
      const r = editor.install(
        opts.binaryPath,
        opts.out ?? SILENT,
        opts.err ?? SILENT,
      );
      if (r.code !== 0) {
        // installZed aborts (code 1) on an unparseable settings file rather
        // than risk clobbering it — that's a real WARN, not a silent failure.
        results.push({
          editor: editor.id,
          action: "error",
          settingsPath,
          error: "settings file not parseable as JSONC — left untouched",
        });
        continue;
      }
      results.push({
        editor: editor.id,
        action: wasRegistered ? "updated" : "registered",
        settingsPath,
      });
    } catch (e) {
      results.push({
        editor: editor.id,
        action: "error",
        settingsPath,
        error: (e as Error).message,
      });
    }
  }

  return results;
}

/** True if a result represents a state an operator should be warned about. */
export function editorConnectorBroken(r: EditorConnectorResult): boolean {
  return r.action === "error" || r.action === "stale";
}
