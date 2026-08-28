/**
 * One keystroke chunk, applied to a text field.
 *
 * Ink reports `key.return` only for a chunk that is EXACTLY `"\r"`. A chunk
 * can carry a newline inside it — a paste, or a terminal that batched
 * keystrokes under load — and then the newline is not a submit, it is a
 * character. Handled naively, `"alice\r"` becomes a persona literally named
 * `"alice\n"`: a directory with a newline in its name, created without a
 * word of warning.
 *
 * The chat box already handled this; the wizard's name field did not, which is
 * how a flaky test found it. So the rule lives here once and both callers use
 * it: split on newlines, the text before the FIRST newline completes the
 * current value and submits, whatever follows stays in the box.
 */

export interface TextChunkResult {
  /** What the field should hold afterwards. */
  text: string;
  /** Present when the chunk contained a newline: the value to submit. */
  submit?: string;
}

export function applyTextChunk(
  current: string,
  chunk: string,
): TextChunkResult {
  const parts = chunk.split(/\r\n|\r|\n/);
  if (parts.length === 1) return { text: current + chunk };
  const head = parts[0] ?? "";
  const rest = parts.slice(1).join(" ").trim();
  const submit = (current + head).trim();
  return submit ? { text: rest, submit } : { text: rest };
}
