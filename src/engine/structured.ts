/**
 * Structured (JSON) output: the instruction that asks for it, the parser
 * that recovers it from a model reply, and the validator bridge.
 *
 * Validation is the application's schema's job (Standard Schema or a plain
 * function); this module only has to get a JSON value out of free text
 * reliably and report precisely why an answer was rejected, because that
 * report is what the retry shows the model.
 */

import type { OutputValidator, StandardSchemaV1 } from "./types.ts";

/** Appended to the system prompt of a structured turn. */
export function structuredOutputInstruction(
  jsonSchema: Record<string, unknown> | undefined,
): string {
  const lines = [
    "## Output format",
    "Reply with exactly ONE JSON value and nothing else: no prose before or after it, no markdown code fence, no comments.",
  ];
  if (jsonSchema) {
    lines.push(
      "The value MUST validate against this JSON Schema:",
      JSON.stringify(jsonSchema),
    );
  }
  return lines.join("\n");
}

/** The follow-up message for a retry after an invalid answer. */
export function structuredRetryMessage(
  originalMessage: string,
  previousAnswer: string,
  problem: string,
): string {
  return [
    originalMessage,
    "",
    "Your previous answer was rejected:",
    problem,
    "",
    "Previous answer (for reference only):",
    previousAnswer.slice(0, 4000),
    "",
    "Answer again with ONLY the corrected JSON value.",
  ].join("\n");
}

export type ParseOutcome =
  | { ok: true; value: unknown }
  | { ok: false; problem: string };

/**
 * Recover a JSON value from a reply. Accepts a bare value, a value wrapped
 * in a ```json fence, or — as a last resort — the first balanced object or
 * array in the text. Never evaluates anything.
 */
export function parseJsonReply(text: string): ParseOutcome {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, problem: "the reply was empty" };

  const candidates: string[] = [trimmed];
  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/.exec(trimmed);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const balanced = firstBalanced(trimmed);
  if (balanced) candidates.push(balanced);

  let lastError = "no JSON value found";
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch (e) {
      lastError = `invalid JSON: ${(e as Error).message}`;
    }
  }
  return { ok: false, problem: lastError };
}

/** The first balanced `{…}` or `[…]` span, string-literal aware. */
function firstBalanced(text: string): string | undefined {
  const start = text.search(/[[{]/);
  if (start < 0) return undefined;
  const open = text[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

export type ValidateOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; problem: string };

function isStandardSchema<T>(v: OutputValidator<T>): v is StandardSchemaV1<T> {
  return (
    typeof v === "object" &&
    v !== null &&
    "~standard" in v &&
    typeof (v as StandardSchemaV1<T>)["~standard"]?.validate === "function"
  );
}

/** Run the application's validator; never throws. */
export async function validateOutput<T>(
  validator: OutputValidator<T>,
  value: unknown,
): Promise<ValidateOutcome<T>> {
  if (isStandardSchema(validator)) {
    try {
      const result = await validator["~standard"].validate(value);
      if (result.issues === undefined) return { ok: true, value: result.value };
      const problem = result.issues
        .slice(0, 10)
        .map((issue) => {
          const path = (issue.path ?? [])
            .map((p) =>
              typeof p === "object" && p !== null && "key" in p
                ? String(p.key)
                : String(p),
            )
            .join(".");
          return path ? `- ${path}: ${issue.message}` : `- ${issue.message}`;
        })
        .join("\n");
      return { ok: false, problem };
    } catch (e) {
      return { ok: false, problem: `validator threw: ${(e as Error).message}` };
    }
  }
  if (typeof validator === "function") {
    try {
      return { ok: true, value: validator(value) };
    } catch (e) {
      return { ok: false, problem: (e as Error).message || String(e) };
    }
  }
  return { ok: false, problem: "schema is neither a Standard Schema nor a function" };
}
