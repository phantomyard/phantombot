/**
 * BODY-PATH GUARD (#718): refuse a shell command that would publish a file
 * PATH as the body of a GitHub review, comment, issue or PR.
 *
 * `gh`'s string flags do no `@file` expansion: `gh pr review --body @/tmp/r.md`
 * and `gh api -f body=@/tmp/r.md` publish the literal text `@/tmp/r.md`, return
 * success, and the real content is lost. It happened four times across three
 * personas in two days. The working forms are `--body-file <path>` and
 * `gh api -F body=@<path>` (typed `-F` DOES read the file), so neither is
 * matched here.
 *
 * DETERMINISTIC AND ALWAYS ON: no model is asked, and every
 * turn gets it, trusted or not. A false positive costs one retry with the
 * right flag; a miss costs a review nobody can read. It only matches a value
 * that is PATH-SHAPED: `@/`, `@~/`, `@./`, `@../`, or a bare relative path
 * (`@review.md`, `@dir/r.md`) that has an extension or a slash AND is the whole
 * value. So a body that merely opens with an `@mention` (`"@kai thanks"`,
 * `-f body=@lena`) is untouched.
 *
 * WHERE IT HOOKS: two seams. On native
 * it is an inline pi extension on `tool_call`. On claude it is a `PreToolUse`
 * hook, matcher `Bash`, that runs `<phantombot> __body_guard`. This is a lint,
 * not a security gate, so an unreadable hook event ALLOWS the call.
 */

/** Hidden argv[2] that runs the claude PreToolUse hook (src/index.ts). */
export const BODY_GUARD_SUBCOMMAND = "__body_guard";

/** `@/x`, `@~/x`, `@./x`, `@../x`: path-shaped however the value goes on. */
const ROOTED_PATH = String.raw`['"]?@(?:/|~/|\./|\.\./)[^\s'"]*`;
/**
 * `review.md`, `dir/r.md`: needs a slash or a FILE extension from a fixed list,
 * so `@lena` and a dotted handle like `@kai.eriksen` are mentions, not paths
 * (PR #754 review, Lena). A bare `@notes.md` with an unlisted extension is
 * still missed: that boundary is the price of never refusing a mention body.
 */
const REL_PATH = String.raw`[\w-][\w.-]*(?:\.(?:md|markdown|txt|json|ya?ml|html?|log|diff|patch)|/[^\s'"]*)`;
/** A bare relative path only counts as the WHOLE value, so `"@kai.e thanks"` is a mention. */
const PATH_VALUE =
  String.raw`(?:${ROOTED_PATH}|'@${REL_PATH}'|"@${REL_PATH}"|@${REL_PATH}(?=[\s;&|)]|$))`;

/**
 * `--body @/x`, `--body=@/x`, `-b @/x`, the joined shorthand `-b@/x` (pflag
 * accepts it), and the raw-field forms `-f body=@/x`, `--raw-field body=@/x`,
 * `-fbody=@/x`. Any raw field counts: `-f` never reads a file, so a
 * path-shaped value is always literal.
 */
const LITERAL_PATH_FLAG = new RegExp(
  String.raw`(?:^|\s)(?:--body(?:=|\s+)|-b(?:=|\s+)?|(?:-f|--raw-field)(?:=|\s+)?['"]?[A-Za-z_][\w.\[\]]*=)` +
    PATH_VALUE,
);

/**
 * True when the command invokes `gh`: bare or path-qualified (`/usr/bin/gh`,
 * `./gh`), in pipelines, `&&`, subshells and `$(which gh)`. Not `gh-pages`.
 */
const INVOKES_GH = /(?:^|[\s;&|(`$/])gh(?![\w.-])/;

/**
 * The offending fragment when `command` would publish a literal `@path` body
 * through `gh`, else undefined.
 */
export function findLiteralBodyPath(command: string): string | undefined {
  if (!INVOKES_GH.test(command)) return undefined;
  const m = LITERAL_PATH_FLAG.exec(command);
  return m ? m[0].trim() : undefined;
}

/** What the turn's model is told when a command is refused. */
export function bodyPathGuardMessage(fragment: string): string {
  return (
    `Blocked by phantombot: \`${fragment}\` would publish the literal path text, ` +
    "not the file's contents (gh string flags do no @file expansion). This " +
    "command was not run. Use `--body-file <path>` for gh pr/issue " +
    "review/comment/create/edit, or `-F body=@<path>` (capital F) for gh api. " +
    "After posting, read the body back to confirm it published."
  );
}

/** The command a tool call would run, for the shell tools of either harness. */
function commandOf(tool: string, input: unknown): string | undefined {
  if (!/^bash$/i.test(tool)) return undefined;
  const c = (input as { command?: unknown } | null | undefined)?.command;
  return typeof c === "string" ? c : undefined;
}

/** Decide one tool call: undefined = run it, a string = the refusal. */
export function bodyPathGuardCheck(tool: string, input: unknown): string | undefined {
  const command = commandOf(tool, input);
  if (command === undefined) return undefined;
  const fragment = findLiteralBodyPath(command);
  return fragment === undefined ? undefined : bodyPathGuardMessage(fragment);
}

/**
 * The claude `PreToolUse` hook: 0 runs the call, 2 blocks it (claude feeds
 * stderr back to the model). An unreadable event allows the call.
 */
export function runBodyGuardHook(
  stdinText: string,
  io: { stderr: (s: string) => void },
): 0 | 2 {
  let event: { tool_name?: unknown; tool_input?: unknown };
  try {
    event = JSON.parse(stdinText) as typeof event;
  } catch {
    return 0;
  }
  if (typeof event?.tool_name !== "string") return 0;
  const refusal = bodyPathGuardCheck(event.tool_name, event.tool_input);
  if (refusal === undefined) return 0;
  io.stderr(refusal + "\n");
  return 2;
}

/** The slice of pi's ExtensionAPI the guard touches. */
export interface BodyGuardToolCallApi {
  on(
    event: "tool_call",
    handler: (event: { toolName: string; input: unknown }) => unknown,
  ): void;
}

/** Inline pi extension (native harness). Always registered. */
export function phantombotBodyGuardExtension(pi: BodyGuardToolCallApi): void {
  pi.on("tool_call", (event) => {
    const refusal = bodyPathGuardCheck(event.toolName, event.input);
    return refusal === undefined ? undefined : { block: true, reason: refusal };
  });
}

/** POSIX-sh double-quote one argv word. */
function quoteArg(s: string): string {
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** The claude PreToolUse entry for the guard: Bash calls only. */
export function claudeBodyGuardHookEntry(command: string[]): Record<string, unknown> {
  return {
    matcher: "Bash",
    hooks: [
      {
        type: "command",
        command: [...command, BODY_GUARD_SUBCOMMAND].map(quoteArg).join(" "),
        timeout: 10,
      },
    ],
  };
}
