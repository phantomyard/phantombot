/**
 * ACP session registry.
 *
 * Zed mints a session per chat thread (one per workspace, typically). We hold
 * an in-memory `Map<sessionId, AcpSession>` for the life of the stdio server.
 * The sessionId is opaque to Zed (an `acp_<random>` token); the STABLE key for
 * phantombot's memory/context is the conversation id, which we DERIVE from the
 * workspace cwd:
 *
 *     conversation = "acp:" + sha256(cwd).slice(0, 12)
 *
 * Keying on cwd (not on the ephemeral sessionId) means closing and reopening
 * Zed on the same project lands back in the same phantombot conversation —
 * memory, last-N window, and embeddings all continue. Phantombot owns ALL
 * context; Zed only ever sends the new user message.
 */

import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";

export interface AcpSession {
  /** Opaque token handed to Zed. Stable for the session's lifetime. */
  readonly sessionId: string;
  /** Workspace working directory Zed opened the session in. */
  readonly cwd: string;
  /** Derived conversation key — phantombot's memory scope. */
  readonly conversation: string;
  /** Persona bound to this session (from the `--persona` flag or config default). */
  readonly persona: string;
  /**
   * Abort controller for the in-flight prompt, if any. `session/cancel` fires
   * it; `session/prompt` installs a fresh one at the start of each turn and
   * clears it when the turn settles.
   */
  abort?: AbortController;
}

/**
 * Derive the stable conversation key from a workspace cwd.
 * `acp:<first 12 hex chars of sha256(cwd)>`.
 */
export function conversationForCwd(cwd: string): string {
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  return `acp:${hash}`;
}

/** Mint an opaque session token. */
export function mintSessionId(): string {
  return `acp_${randomBytes(12).toString("hex")}`;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, AcpSession>();

  /**
   * Create + register a new session for a workspace cwd. The conversation key
   * is derived from cwd, so two sessions in the same workspace share memory.
   */
  create(cwd: string, persona: string, sessionId?: string): AcpSession {
    const session: AcpSession = {
      sessionId: sessionId ?? mintSessionId(),
      cwd,
      conversation: conversationForCwd(cwd),
      persona,
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  get(sessionId: string): AcpSession | undefined {
    return this.sessions.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
