/**
 * phantombot as a first-class VS Code chat model via the Language Model Chat
 * Provider API (`vscode.lm.registerLanguageModelChatProvider`, stable ≥1.104).
 *
 * This is what makes the experience match Zed's external-agent slot: the user
 * picks "Phantombot" from the model dropdown in the native Chat view and just
 * types — no `@phantombot` mention, and VS Code renders the conversation history
 * natively. Under the hood phantombot still runs its OWN agent loop (persona,
 * memory, tools — all server-side over the same embedded ACP client the
 * `@phantombot` participant uses); VS Code merely thinks it's talking to a model.
 *
 * This module is the thin `vscode`-dependent glue (like extension.ts). All the
 * load-bearing logic — reducing VS Code's replayed transcript to just the latest
 * user turn so phantombot's server-side memory doesn't double up, and streaming
 * the response — lives in the pure, unit-tested lmBridge.ts.
 */

import * as vscode from "vscode";

import {
  driveLmResponse,
  estimateTokens,
  latestUserPrompt,
  type LmMessageLike,
} from "./lmBridge.ts";

/** A live ACP connection for a workspace (shape shared with extension.ts). */
export interface LmConnection {
  client: import("./acpClient.ts").AcpClient;
  sessionId: string;
  cwd: string;
}

export interface LmProviderDeps {
  /** Get-or-create the ACP connection for a workspace cwd (throws on failure). */
  ensureConnection(cwd: string): Promise<LmConnection>;
  /** Drop a dead connection so the next turn respawns. */
  dropConnection(cwd: string): void;
  /** The workspace cwd to bind this turn to. */
  currentCwd(): string;
  /** Configured persona label for the model card (empty ⇒ phantombot default). */
  personaLabel(): string;
  output: vscode.OutputChannel;
}

/** Stable id for the single model this provider exposes. */
const MODEL_ID = "phantombot";

export function createLanguageModelChatProvider(
  deps: LmProviderDeps,
): vscode.LanguageModelChatProvider {
  return {
    async provideLanguageModelChatInformation(_options, _token) {
      const persona = deps.personaLabel().trim();
      const info: vscode.LanguageModelChatInformation = {
        id: MODEL_ID,
        name: persona ? `Phantombot (${persona})` : "Phantombot",
        family: "phantombot",
        version: "1",
        // phantombot manages its own context window server-side; these are
        // generous sentinels so VS Code never truncates our single user turn.
        maxInputTokens: 200_000,
        maxOutputTokens: 64_000,
        detail: persona
          ? `persona: ${persona} — memory & tools server-side`
          : "persona, memory & tools server-side",
        tooltip: "phantombot — persona, memory and tools live server-side",
        capabilities: {
          imageInput: true,
          // phantombot owns its tools server-side; we do NOT let VS Code inject
          // or decompose tools, so the agent stays itself.
          toolCalling: false,
        },
      };
      return [info];
    },

    async provideLanguageModelChatResponse(
      _model,
      messages,
      _options,
      progress,
      token,
    ) {
      const cwd = deps.currentCwd();

      let conn: LmConnection;
      try {
        conn = await deps.ensureConnection(cwd);
      } catch (e) {
        const msg = (e as Error).message;
        deps.output.appendLine(`[lm] connection failed: ${msg}`);
        progress.report(
          new vscode.LanguageModelTextPart(
            `**phantombot could not start.**\n\n${msg}`,
          ),
        );
        return;
      }

      // Reduce VS Code's full replayed transcript to ONLY the latest user turn.
      // Everything else goes down the drain — phantombot's server-side memory is
      // the source of truth (see lmBridge.ts).
      const blocks = latestUserPrompt(
        messages as unknown as readonly LmMessageLike[],
      );
      if (blocks.length === 0) return; // empty turn — nothing to send.

      try {
        const stopReason = await driveLmResponse({
          client: conn.client,
          sessionId: conn.sessionId,
          blocks,
          progress,
          makeTextPart: (text) => new vscode.LanguageModelTextPart(text),
          token: {
            isCancellationRequested: token.isCancellationRequested,
            onCancellationRequested: (l) => token.onCancellationRequested(l),
          },
        });
        if (stopReason === "refusal") {
          progress.report(
            new vscode.LanguageModelTextPart(
              "\n\n_(phantombot declined this turn.)_",
            ),
          );
        }
      } catch (e) {
        // Subprocess died or the agent errored. Surface it, drop the dead
        // connection so the next turn respawns, and mark the request errored.
        const msg = (e as Error).message;
        conn.client.dispose();
        deps.dropConnection(cwd);
        deps.output.appendLine(`[lm] ${msg}`);
        progress.report(
          new vscode.LanguageModelTextPart(`\n\n**phantombot error:** ${msg}`),
        );
        throw e;
      }
    },

    async provideTokenCount(_model, text, _token) {
      const s = typeof text === "string" ? text : JSON.stringify(text);
      return estimateTokens(s);
    },
  };
}
