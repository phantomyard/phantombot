/**
 * Shared tool-call note formatter (issue #218).
 *
 * Every harness adapter (claude, codex, gemini, pi) emits a `progress` chunk
 * when the model invokes a tool. That note becomes the `title` of the ACP
 * `tool_call` update Zed renders in its agent panel. Historically each adapter
 * built a bare `"tool: <name>"` string inline (codex didn't even capture the
 * name), so the panel showed undifferentiated labels — you couldn't tell
 * `Bash: git status` from `Bash: rm -rf /`.
 *
 * This module centralises the formatting so the per-tool rules live in ONE
 * place and every harness benefits. Adapters are responsible only for the
 * (per-harness, differently-shaped) extraction of the tool name + raw input;
 * they hand both here and get back a single-line, length-capped title.
 *
 * Design notes:
 *   - Backward compatible: when no useful detail can be extracted we return the
 *     exact legacy `"tool: <name>"` (or bare `"tool"`) string, so existing
 *     /status wording and tests are unchanged. The richer `"<Name>: <detail>"`
 *     shape is purely additive — it only appears when args are present.
 *   - Extraction keys on well-known INPUT FIELD NAMES (command, file_path,
 *     query…) rather than per-harness tool names, so one rule set works across
 *     all adapters even though their event shapes differ.
 *   - Minimal redaction by design (Andrew's call on #218): we truncate and
 *     collapse whitespace; we do NOT attempt secret masking. Keep this in mind
 *     before surfacing inputs to any noisier sink than the Zed panel.
 *   - Never throws. Bad/partial input degrades to the legacy label.
 */

/** Max length of a rendered tool-call title, including the name prefix. */
export const MAX_TOOL_NOTE_LEN = 80;

/**
 * ACP `ToolKind` — drives the per-tool icon Zed renders in its agent panel.
 * Matches the ACP `ToolKind` enum exactly; `other` is the safe catch-all.
 */
export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "fetch"
  | "other";

/** A file location the editor can render as a clickable jump-to-file link. */
export interface ToolLocation {
  /**
   * The path the editor should open. As extracted here it is whatever the
   * harness tool arg contained — usually relative to the session cwd
   * (`src/foo.ts`), occasionally already absolute. The ACP boundary
   * (`toAbsoluteLocations` in connectors/acp/protocol.ts) resolves relative
   * paths against the session cwd so the wire always carries an ABSOLUTE path,
   * as the ACP `ToolCallLocation.path` spec requires.
   */
  path: string;
  /** 1-based line to jump to, when known. Optional — file open still works. */
  line?: number;
}

/**
 * Structured tool-call detail (issue #231, Part 2). A superset of the
 * legacy `buildToolNote` string: `title` is byte-identical to what
 * `buildToolNote` returns, and the extra fields drive the ACP panel's
 * icon (`kind`) and clickable paths (`locations`).
 */
export interface ToolCallDetail {
  /** Single-line, length-capped title — identical to `buildToolNote(...)`. */
  title: string;
  /** ACP ToolKind, used for the panel icon. */
  kind: ToolKind;
  /** File paths to surface as clickable links. Empty for non-file tools. */
  locations: ToolLocation[];
  /**
   * Optional richer preview body. Intentionally left unpopulated for now:
   * the only readily-available preview is the raw command/args, and
   * surfacing more of a Bash command than the (already-truncated, un-masked)
   * title does would reopen the secret-masking question flagged as a
   * carry-over in #218 Part 1 / #231. The field is plumbed so the wire type
   * is complete; populate it once redaction lands.
   */
  content?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Collapse all runs of whitespace (incl. newlines) to single spaces + trim. */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Pull the first usable string from `input` across a list of candidate keys.
 * Handles plain strings and string arrays (codex shell `command` is an array
 * of argv tokens). Returns undefined if nothing usable is present.
 */
function firstField(
  input: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const v = input[key];
    if (typeof v === "string") {
      const c = collapse(v);
      if (c) return c;
    } else if (Array.isArray(v)) {
      const joined = collapse(
        v.filter((x): x is string => typeof x === "string").join(" "),
      );
      if (joined) return joined;
    }
  }
  return undefined;
}

/**
 * Extract a human-meaningful detail string from a tool's raw input, keyed on
 * common field names so it works regardless of which harness produced it.
 */
function extractToolDetail(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;

  // Shell/command tools (Bash, shell, run_shell_command, bash…)
  const command = firstField(input, ["command", "cmd"]);
  if (command) return command;

  // File tools (Read/Edit/Write, read_file/write_file/replace…)
  const path = firstField(input, [
    "file_path",
    "filePath",
    "path",
    "absolute_path",
  ]);
  if (path) return path;

  // Search tools (Grep/Glob, search…)
  const pattern = firstField(input, ["pattern", "query"]);
  if (pattern) return pattern;

  // Sub-agent / task delegation (Agent/Task): subagent + a prompt snippet.
  const subagent = firstField(input, ["subagent_type", "description"]);
  const prompt = firstField(input, ["prompt"]);
  if (subagent && prompt) return `${subagent} — ${prompt}`;
  if (subagent) return subagent;
  if (prompt) return prompt;

  // Web tools
  const url = firstField(input, ["url"]);
  if (url) return url;

  return undefined;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return "…";
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Build the progress note (ACP tool_call title) for a tool invocation.
 *
 * @param toolName the tool's name, if the harness captured it
 * @param input    the tool's raw arguments object (any shape; may be missing)
 */
export function buildToolNote(
  toolName: string | undefined,
  input?: unknown,
): string {
  const name = typeof toolName === "string" ? collapse(toolName) : "";

  if (name) {
    const detail = extractToolDetail(input);
    if (detail) return truncate(`${name}: ${detail}`, MAX_TOOL_NOTE_LEN);
    // No detail → preserve the exact legacy label for back-compat.
    return `tool: ${name}`;
  }

  // No name at all (some codex/pi events) → legacy bare fallback.
  return "tool";
}

/**
 * Tool NAME → ToolKind. Keyed on the normalised name (lowercased, spaces and
 * hyphens folded to `_`) so the many per-harness spellings of the same tool
 * collapse to one entry (Read/read_file/readFile → `read`).
 */
const KIND_BY_NAME: Readonly<Record<string, ToolKind>> = {
  read: "read",
  read_file: "read",
  readfile: "read",
  view: "read",
  cat: "read",
  edit: "edit",
  multiedit: "edit",
  write: "edit",
  write_file: "edit",
  writefile: "edit",
  create_file: "edit",
  replace: "edit",
  str_replace: "edit",
  str_replace_editor: "edit",
  apply_patch: "edit",
  notebookedit: "edit",
  bash: "execute",
  shell: "execute",
  run_shell_command: "execute",
  run_command: "execute",
  run_terminal_cmd: "execute",
  exec: "execute",
  execute: "execute",
  run: "execute",
  grep: "search",
  glob: "search",
  search: "search",
  grep_search: "search",
  file_search: "search",
  codebase_search: "search",
  find: "search",
  webfetch: "fetch",
  web_fetch: "fetch",
  fetch: "fetch",
  websearch: "fetch",
  web_search: "fetch"
};

/** Field names whose value is a file path the editor can open. */
const PATH_KEYS = [
  "file_path",
  "filePath",
  "path",
  "absolute_path",
  "notebook_path"
] as const;

/** Normalise a tool name for KIND_BY_NAME lookup. */
function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[\s-]+/g, "_");
}

/**
 * Map a tool to its ACP `kind`. Prefers the tool NAME (Read→read, Bash→execute)
 * and falls back to input FIELD names when the name is unknown/absent, mirroring
 * how {@link buildToolNote} extracts detail. Defaults to `other`.
 */
function classifyKind(name: string, input: unknown): ToolKind {
  if (name) {
    const direct = KIND_BY_NAME[normaliseName(name)];
    if (direct) return direct;
  }
  if (isRecord(input)) {
    if (firstField(input, ["command", "cmd"])) return "execute";
    if (firstField(input, ["pattern", "query"])) return "search";
    if (firstField(input, ["url"])) return "fetch";
    if (firstField(input, PATH_KEYS)) return "read";
  }
  return "other";
}

/**
 * Extract clickable file locations from a tool's raw input. De-duplicates and
 * ignores anything that isn't a non-empty string path. Returns [] when the
 * tool touches no files (shell/search/web tools).
 */
function extractLocations(input: unknown): ToolLocation[] {
  if (!isRecord(input)) return [];
  const locations: ToolLocation[] = [];
  const seen = new Set<string>();
  for (const key of PATH_KEYS) {
    const v = input[key];
    if (typeof v !== "string") continue;
    const path = collapse(v);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    locations.push({ path });
  }
  return locations;
}

/**
 * Build the structured tool-call detail (issue #231, Part 2).
 *
 * `title` is byte-identical to {@link buildToolNote} — existing string-only
 * consumers (and #218's tests) are unaffected. The extra fields are additive:
 *   - `kind`      → the ACP panel icon
 *   - `locations` → clickable jump-to-file paths
 * Never throws; bad/partial input degrades to `{ kind: 'other', locations: [] }`.
 *
 * @param toolName the tool's name, if the harness captured it
 * @param input    the tool's raw arguments object (any shape; may be missing)
 */
export function buildToolCall(
  toolName: string | undefined,
  input?: unknown
): ToolCallDetail {
  const name = typeof toolName === "string" ? collapse(toolName) : "";
  return {
    title: buildToolNote(toolName, input),
    kind: classifyKind(name, input),
    locations: extractLocations(input)
  };
}
