/**
 * Pure helpers for the phantombot VS Code commands (the menu-launcher /
 * discoverability surface added alongside the chat participant):
 *
 *   - "Chat with Phantombot" (Command Palette + chat-view title-bar button)
 *       → opens the Chat panel pre-filled with `@phantombot `.
 *   - "Ask Phantombot about this" (editor right-click context menu)
 *       → opens the Chat panel pre-filled with `@phantombot ` plus a fenced
 *         snippet of the current selection so the agent has the code in context.
 *
 * The `vscode`-touching glue (registerCommand + commands.executeCommand of
 * `workbench.action.chat.open`) lives in extension.ts. EVERYTHING that decides
 * WHAT query string to open with is here, pure, so it's unit-tested under
 * `bun test` with no `vscode` dependency.
 */

/** The participant mention every command pre-fills the chat box with. */
export const PARTICIPANT_MENTION = "@phantombot";

/** The bare "open an empty turn addressed to phantombot" query. */
export function openChatQuery(): string {
  return `${PARTICIPANT_MENTION} `;
}

export interface SelectionContext {
  /** The selected text (may be empty when there's no selection). */
  selectedText: string;
  /** The VS Code languageId of the active document, for the fence (optional). */
  languageId?: string;
  /** The file's base name, surfaced so the agent knows what it's looking at. */
  fileName?: string;
}

/**
 * Build the chat query for "Ask Phantombot about this". With a non-empty
 * selection we fence it (using the document's languageId for syntax) and prefix
 * a short instruction; with no selection we degrade gracefully to a plain
 * addressed turn so the command is never a dead no-op.
 *
 * Pure string-building — trims trailing whitespace off the selection but keeps
 * internal formatting, and never throws on odd input.
 */
export function askAboutSelectionQuery(ctx: SelectionContext): string {
  const selection = (ctx.selectedText ?? "").replace(/\s+$/, "");
  if (selection.length === 0) {
    // Nothing selected — still open an addressed turn so the user can type.
    return openChatQuery();
  }
  const lang = (ctx.languageId ?? "").trim();
  const where = ctx.fileName ? ` from \`${ctx.fileName}\`` : "";
  const fence = "```";
  return (
    `${PARTICIPANT_MENTION} About this code${where}:\n\n` +
    `${fence}${lang}\n${selection}\n${fence}\n`
  );
}
