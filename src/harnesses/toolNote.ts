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
