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
import {
  defaultJetbrainsConfigPath,
  installJetbrains,
} from "./installJetbrains.ts";
import {
  checkVscode,
  installVscode,
  type VscodeInstallResult,
} from "./installVscode.ts";
import {
  checkProposedApi,
  ensureProposedApi,
  type ProposedApiOptions,
  type ProposedApiResult,
  type ProposedApiStatus,
} from "./vscodeArgv.ts";

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
  /**
   * VS Code only. Whether our side-loaded extension is allow-listed for the
   * proposed chat APIs it declares, via `~/.vscode/argv.json`. Orthogonal to
   * `action`: the extension can be installed and current (`action: "current"`)
   * while still lacking the allow-list entry, in which case it silently
   * degrades to the `@phantombot` participant instead of a native chat session.
   * Undefined for editors where the concept doesn't apply.
   */
  proposedApi?: ProposedApiStatus;
  /** Detail for a `proposedApi: "error"`. */
  proposedApiError?: string;
}

/**
 * One supported editor. Kept tiny + data-driven so the reconcile loop below is
 * editor-agnostic.
 *
 * There are two shapes of editor, both error-isolated by the loop:
 *
 *   1. SETTINGS editors (Zed) — phantombot registers itself by merging a key
 *      into the editor's settings.json. These implement
 *      `settingsPath`/`detectionDir`/`currentCommand`/`install`; the loop owns
 *      the detect → compare(binaryPath) → write idempotency.
 *
 *   2. SELF-DRIVEN editors (VS Code) — there is NO native ACP and NO
 *      settings-only registration, so phantombot ships its own extension and
 *      installs it via the `code` CLI. The settings model doesn't fit (the
 *      "desired state" is a bundled extension version, not a binary path), so
 *      these implement `reconcile()` and fully own their own detect →
 *      version-compare → install logic, returning a ready EditorConnectorResult.
 *      `reconcile` takes precedence; when present the loop just calls it
 *      (still wrapped in try/catch for isolation).
 */
export interface EditorSpec {
  id: string;
  /**
   * Self-driven editors implement this and own their whole flow. When present,
   * the other (settings-model) fields are ignored.
   */
  reconcile?: (opts: { repair: boolean; out: WriteSink; err: WriteSink }) =>
    EditorConnectorResult;
  /** Resolve this editor's settings.json path. (settings editors) */
  settingsPath?(): string;
  /**
   * Directory whose existence signals the editor is present. Defaults to the
   * settings file's parent dir (e.g. ~/.config/zed). (settings editors)
   */
  detectionDir?(settingsPath: string): string;
  /** Read the phantombot command currently registered, if any. (settings editors) */
  currentCommand?(settingsPath: string): string | undefined;
  /** Perform the idempotent registration write. Returns a 0/1 code. (settings editors) */
  install?(binaryPath: string, out?: WriteSink, err?: WriteSink): { code: number };
}

/**
 * Best-effort read of `agent_servers.Phantombot.command` from a JSONC ACP
 * settings file. Both Zed (settings.json) and JetBrains (~/.jetbrains/acp.json)
 * use this exact shape, so they share one reader.
 */
function readAgentServerCommand(settingsPath: string): string | undefined {
  try {
    const raw = readFileSync(settingsPath, "utf8");
    // Tolerant parse (comments + trailing commas). On a malformed file this
    // returns a best-effort value or undefined; either way the installer
    // re-parses with error collection and aborts safely, so we never risk data
    // loss here.
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
  currentCommand: readAgentServerCommand,
  install: (binaryPath, out, err) => installZed({ binaryPath, out, err }),
};

/**
 * JetBrains AI Assistant (Rider, IntelliJ IDEA, WebStorm, PyCharm, …) speaks
 * ACP natively from 2026.1, reading external agents from a single shared
 * per-user file `~/.jetbrains/acp.json`. Registration is the same settings
 * merge as Zed — no IDE plugin required — so it's a plain settings-model editor.
 */
export const JETBRAINS_EDITOR: EditorSpec = {
  id: "jetbrains",
  settingsPath: defaultJetbrainsConfigPath,
  detectionDir: (configPath) => dirname(configPath),
  currentCommand: readAgentServerCommand,
  install: (binaryPath, out, err) => installJetbrains({ binaryPath, out, err }),
};

/**
 * Map an installVscode/checkVscode result onto the shared EditorConnectorResult
 * vocabulary so VS Code shows up in `doctor` exactly like Zed. There's no
 * settings file, so `settingsPath` carries the resolved `code` CLI (or "" when
 * not detected) for a useful diagnostic line.
 *
 * In REPAIR mode the result came from installVscode (work was done): `installed`
 * → registered, `updated` → updated. In REPORT-ONLY mode the result came from
 * checkVscode (no work done): `installed`/`updated` both mean "drift that a
 * repair would fix" → reported as `stale` so doctor flags it without claiming
 * we changed anything.
 */
export function vscodeResultToConnector(
  r: VscodeInstallResult,
  repair: boolean,
): EditorConnectorResult {
  const settingsPath = r.codeCommand ?? "";
  switch (r.action) {
    case "not-detected":
      return { editor: "vscode", action: "not-detected", settingsPath };
    case "current":
      return { editor: "vscode", action: "current", settingsPath };
    case "installed":
      return {
        editor: "vscode",
        action: repair ? "registered" : "stale",
        settingsPath,
      };
    case "updated":
      return {
        editor: "vscode",
        action: repair ? "updated" : "stale",
        settingsPath,
      };
    case "error":
      return {
        editor: "vscode",
        action: "error",
        settingsPath,
        error: r.message,
      };
  }
}

/**
 * Installing the .vsix is only HALF of a working VS Code integration: the
 * extension declares proposed chat APIs that stable VS Code withholds unless
 * the extension id is allow-listed in `~/.vscode/argv.json`. Reconcile both, in
 * that order.
 *
 * The argv.json step is gated on the extension step having found VS Code. When
 * `code` isn't on the box (`not-detected`) or the install itself failed
 * (`error`), we don't go creating a `~/.vscode/argv.json` for an editor the
 * user doesn't have — that's the same "never provision what wasn't asked for"
 * rule the settings-model editors enforce with their `detectionDir` probe.
 */
/**
 * The impure halves of a VS Code reconcile, injectable so the GATING logic
 * below is unit-testable without a real `code` CLI and — critically — without
 * writing the dev box's real `~/.vscode/argv.json`.
 */
export interface VscodeReconcileHooks {
  install(): VscodeInstallResult;
  check(): VscodeInstallResult;
  ensureArgv(options?: ProposedApiOptions): ProposedApiResult;
  checkArgv(options?: ProposedApiOptions): ProposedApiResult;
}

/**
 * Installing the .vsix is only HALF of a working VS Code integration: the
 * extension declares proposed chat APIs that stable VS Code withholds unless
 * the extension id is allow-listed in `~/.vscode/argv.json`. Reconcile both, in
 * that order.
 *
 * The argv.json step is GATED on the extension step having actually found VS
 * Code. When `code` isn't on the box (`not-detected`) or the install itself
 * failed (`error`), we don't go creating a `~/.vscode/argv.json` for an editor
 * the user may not even have — that's the same "never provision what wasn't
 * asked for" rule the settings-model editors enforce via `detectionDir`.
 *
 * The CLI the extension step actually resolved is threaded into the argv step,
 * so we allow-list the extension in the SAME distribution we installed it into
 * rather than in whatever `.vscode` happens to sit in `$HOME`.
 */
export function reconcileVscode(
  repair: boolean,
  hooks: Partial<VscodeReconcileHooks> = {},
): EditorConnectorResult {
  const install = hooks.install ?? installVscode;
  const check = hooks.check ?? checkVscode;
  const ensureArgv = hooks.ensureArgv ?? ensureProposedApi;
  const checkArgv = hooks.checkArgv ?? checkProposedApi;

  const result = repair ? install() : check();
  const connector = vscodeResultToConnector(result, repair);
  if (connector.action === "not-detected" || connector.action === "error") {
    return connector;
  }
  const argvOptions: ProposedApiOptions = result.codeCommand
    ? { codeCommand: result.codeCommand }
    : {};
  const argv = repair ? ensureArgv(argvOptions) : checkArgv(argvOptions);
  connector.proposedApi = argv.status;
  if (argv.error) connector.proposedApiError = argv.error;
  return connector;
}

export const VSCODE_EDITOR: EditorSpec = {
  id: "vscode",
  reconcile: ({ repair }) => reconcileVscode(repair),
};

/** Editors phantombot knows how to register itself into. */
export const KNOWN_EDITORS: EditorSpec[] = [
  ZED_EDITOR,
  JETBRAINS_EDITOR,
  VSCODE_EDITOR,
];

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
      // Self-driven editors (VS Code) own their whole detect → version-check →
      // install flow and return a ready result. Still wrapped by this try/catch
      // for isolation, but they never use the settings-file machinery below.
      if (editor.reconcile) {
        results.push(
          editor.reconcile({
            repair,
            out: opts.out ?? SILENT,
            err: opts.err ?? SILENT,
          }),
        );
        continue;
      }

      // ── Settings-model editors (Zed) from here down. ──
      if (
        !editor.settingsPath ||
        !editor.detectionDir ||
        !editor.currentCommand ||
        !editor.install
      ) {
        throw new Error(
          `editor "${editor.id}" is neither reconcile-driven nor a complete settings editor`,
        );
      }
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

/**
 * True if a result represents a state an operator should be warned about.
 *
 * A missing proposed-api allow-list counts: the extension is installed but runs
 * degraded, which is precisely the failure mode nobody notices. `enabled` does
 * NOT count — we just fixed it (though VS Code needs a restart to see it).
 */
export function editorConnectorBroken(r: EditorConnectorResult): boolean {
  return (
    r.action === "error" ||
    r.action === "stale" ||
    r.proposedApi === "error" ||
    r.proposedApi === "stale"
  );
}
