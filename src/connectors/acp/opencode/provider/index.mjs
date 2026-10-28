/**
 * Phantombot provider package for OpenCode.
 *
 * OpenCode v2 loads a provider from a package specifier; this module is the one
 * `phantombot acp install opencode` points it at. It spawns `phantombot acp` as
 * a CHILD PROCESS and speaks the Agent Client Protocol over its stdin/stdout —
 * exactly what Zed already does — so the integration needs no daemon, no port,
 * no token and no network stack, and it keeps working while the Phantombot
 * service is down.
 *
 * ## Why the module looks like THIS (read before "simplifying" it)
 *
 * The obvious shape — export `model(modelID, settings)` returning OpenCode's own
 * `LanguageModel` — does not work, and fails in a way that looks like a bug in
 * this file. `Provider.importPackage` (packages/core/src/provider.ts, v2.2.0)
 * requires that export, but the value is then checked with
 * `LanguageModelSchema`, which is `Schema.declare(value => value instanceof
 * LanguageModel)` — an *identity* check against a class that lives inside
 * OpenCode's binary. An external `file://` module cannot import `@opencode/ai`
 * (verified: every such specifier fails to resolve), so it can never satisfy
 * that check. The first attempted install therefore always died with
 * "Schema validation failed".
 *
 * The seam that DOES work is OpenCode's AI-SDK route: a provider whose
 * `package` starts with `aisdk:` is loaded by the built-in
 * `opencode.provider.dynamic` plugin, which
 *
 *   1. imports the module,
 *   2. finds the FIRST export whose name starts with `create`,
 *   3. calls it with the provider's flattened `settings` and expects an object
 *      exposing `languageModel(modelID)`,
 *   4. uses the returned model through the AI SDK `LanguageModelV3` contract —
 *      a plain object, duck-typed, no class identity.
 *
 * That is why this file exports exactly ONE `create*` symbol and returns AI SDK
 * models rather than OpenCode ones.
 *
 * ## The ACP conversation model
 *
 * OpenCode replays the whole transcript on every request and knows nothing about
 * Phantombot's server-side memory, so this module:
 *
 *   - sends only the turns Phantombot has NOT seen (prefix-matched against what
 *     this instance already sent), never the full transcript;
 *   - keeps ONE ACP session per OpenCode conversation, and starts a new one when
 *     the incoming transcript does not extend a known conversation (a fork, a
 *     fresh chat that happens to share an opening line, or — see
 *     `continuesConversation` — a transcript whose ASSISTANT history disagrees
 *     with the replies this instance actually produced);
 *   - re-registers its known sessions with `session/load` when it has to replace
 *     the child process, because the ACP server keeps its session registry in
 *     memory and rejects ids a new child never issued;
 *   - never dispatches a prompt for a turn that was already aborted, whether the
 *     abort landed before the call or while it waited its turn in the queue;
 *   - answers OpenCode's session-title requests locally. OpenCode asks the same
 *     model to name the conversation with the conversation's first user message
 *     as its prompt; sending that to Phantombot would burn a real turn, write a
 *     bogus memory row, and — because its prompt is a prefix of the real first
 *     turn — corrupt the conversation matching below.
 *
 * Zero dependencies beyond `node:` builtins: no npm install, no build step at
 * install time, nothing for a user to keep in sync.
 */

import { spawn } from "node:child_process";

/** Binary spawned when the install did not bake an absolute path in. */
const DEFAULT_COMMAND = "phantombot";

/** A Phantombot turn can legitimately run for many minutes; only bound the setup. */
const INIT_TIMEOUT_MS = 60_000;
const PROMPT_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/** How long an aborted ACP session gets to acknowledge `session/cancel`. */
const CANCEL_GRACE_MS = 2_000;

/** Per-instance conversation registry cap — same spirit as the gateway's scan limit. */
const MAX_CONVERSATIONS = 200;

/** Runtime caches, keyed by spawn identity + persona (OpenCode calls `create*` per model). */
const runtimes = new Map();

/** Sentinel used by `finish` parts. */
const STOP = {
  end_turn: "stop",
  max_tokens: "length",
  refusal: "content-filter",
  cancelled: "other",
};

// ── ACP transport ────────────────────────────────────────────────────────

/**
 * One `phantombot acp` child process and the newline-delimited JSON-RPC
 * connection to it. Nothing is spawned until the first request, because
 * OpenCode calls `languageModel()` more than once per model and the child must
 * never be created as a side effect of that.
 */
class AcpConnection {
  constructor({ command, args, cwd }) {
    this.command = command;
    this.args = args;
    this.stderr = "";
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.closed = false;
    this.closing = null;
    this.failure = null;
    this.capabilities = {};
    this.onNotification = () => {};

    this.child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.consume(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    // `spawn` and `error` are mutually exclusive and both asynchronous. Requests
    // wait on this promise so a missing binary reports ENOENT with the fix in it,
    // instead of racing ahead and failing with a generic "not running".
    this.spawned = new Promise((resolve, reject) => {
      this.child.once("spawn", () => resolve());
      this.child.once("error", (error) => {
        this.failure = friendlySpawnError(error, command);
        reject(this.failure);
      });
    });
    // Nobody may await it (a fire-and-forget close path); keep the rejection handled.
    this.spawned.catch(() => {});
    this.child.on("exit", (code, signal) => {
      const detail = this.stderr.trim();
      this.fail(
        new Error(
          `phantombot acp exited (${signal ? `signal ${signal}` : `code ${code}`})` +
            (detail ? `: ${detail}` : "") +
            hintForCode(code, signal),
        ),
      );
    });
  }

  consume(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // stdout is the protocol channel; ignore anything non-JSON.
      }
      if (message && typeof message === "object" && "id" in message && message.id !== null) {
        const waiting = this.pending.get(message.id);
        if (!waiting) continue;
        this.pending.delete(message.id);
        if (waiting.timer) clearTimeout(waiting.timer);
        if (message.error) {
          waiting.reject(new Error(message.error.message ?? "ACP request failed"));
        } else {
          waiting.resolve(message.result);
        }
        continue;
      }
      this.onNotification(message);
    }
  }

  write(message) {
    if (this.closed || !this.child.stdin.writable) {
      throw this.failure ?? new Error("phantombot acp is not running");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async request(method, params, timeoutMs = INIT_TIMEOUT_MS) {
    await this.spawned;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(this.failure ?? new Error("phantombot acp is not running"));
        return;
      }
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`phantombot acp did not answer ${method} within ${timeoutMs}ms`));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(error);
      }
    });
  }

  notify(method, params) {
    try {
      this.write({ jsonrpc: "2.0", method, params });
    } catch {
      // Nothing to tell a dead child.
    }
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.failure = this.failure ?? error;
    for (const [, waiting] of this.pending) {
      if (waiting.timer) clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
  }

  /** Tear the child down. Idempotent. */
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const [, waiting] of this.pending) {
      if (waiting.timer) clearTimeout(waiting.timer);
      waiting.reject(new Error("phantombot acp was closed"));
    }
    this.pending.clear();
    this.closing = new Promise((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve();
        return;
      }
      this.child.once("exit", () => resolve());
      try {
        this.child.stdin.end();
      } catch {
        // already gone
      }
      this.child.kill();
      setTimeout(resolve, 1_000).unref?.();
    });
    return this.closing;
  }
}

function friendlySpawnError(error, command) {
  if (error && error.code === "ENOENT") {
    return new Error(
      `cannot find the phantombot binary at "${command}". Run \`phantombot acp install opencode\` again (it bakes the absolute path in), or set providers.phantombot.settings.command in your OpenCode config.`,
    );
  }
  if (error && error.code === "EACCES") {
    return new Error(`phantombot binary "${command}" is not executable.`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function hintForCode(code, signal) {
  if (signal) return " — killed before the turn finished.";
  if (code === 0) return " — it exited cleanly, so the turn could not complete.";
  return "";
}

// ── prompt handling ──────────────────────────────────────────────────────

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** Flatten AI SDK prompt content into plain text. */
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/**
 * Split the incoming request into system text and the ordered conversation
 * entries. BOTH roles are kept, in order: matching a transcript on user turns
 * alone would let a request that carries a visibly different assistant reply
 * resume somebody else's thread and inherit the missing history.
 *
 * System-reminders are stripped from every entry: Phantombot's own harness
 * already supplies its context, and OpenCode's reminders change between retries
 * of the same turn, which would defeat the matching below.
 *
 * `turns` stays user-only — it is what gets sent, what the title detector reads
 * and what decides whether the request is empty.
 */
function readPrompt(prompt) {
  const system = [];
  const entries = [];
  const turns = [];
  for (const message of Array.isArray(prompt) ? prompt : []) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "system") {
      system.push(textOf(message.content));
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = textOf(message.content).replace(SYSTEM_REMINDER, "").trim();
    if (!text) continue;
    entries.push({ role: message.role, text });
    if (message.role === "user") turns.push(text);
  }
  return { system: system.join("\n\n"), entries, turns };
}

/**
 * OpenCode names each new conversation by asking the SAME model with a fixed
 * instruction and the first user message. Recognising it lets us answer locally
 * instead of spending a Phantombot turn (and polluting its memory) on a title.
 * If upstream rewords the instruction this check simply stops matching and the
 * request falls through to Phantombot — the old, correct-but-costly behaviour.
 */
function isTitleRequest(system, turns) {
  return turns.length === 1 && /name conversations/i.test(system) && /list of past sessions/i.test(system);
}

function localTitle(turns) {
  const words = turns[0].replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ");
  const title = words.replace(/[.,;:!?]+$/, "").slice(0, 60);
  return title || "New session";
}

// ── conversation matching ────────────────────────────────────────────────

/** Same message: same role, same text. Both sides are reminder-stripped + trimmed. */
function sameEntry(a, b) {
  return a.role === b.role && a.text === b.text;
}

/**
 * Does `supplied` continue — or retry the tail of — the transcript `stored`?
 *
 * The whole prior transcript is compared, role included, not just the user
 * turns. Two shapes qualify:
 *
 *   1. `supplied` extends `stored` (every stored entry appears verbatim at the
 *      same index). The extra entries are the turns to send. This is the normal
 *      continuation, and also a byte-identical replay.
 *   2. `supplied` stops exactly one entry short of `stored`, at a user turn, and
 *      the omitted entry is the assistant reply this instance produced — the
 *      client re-asking the same question. That reply is regenerated, so it is
 *      not required to be echoed back.
 *
 * Anything else — an edited turn, a different opening, or an assistant reply
 * that contradicts what we actually wrote — is a DIFFERENT conversation. It gets
 * a fresh session, so a private answer can never be attached to a transcript
 * that visibly disagrees with it.
 */
function continuesConversation(stored, supplied) {
  if (stored.length === 0 || supplied.length === 0) return false;
  const overlap = Math.min(stored.length, supplied.length);
  for (let index = 0; index < overlap; index += 1) {
    if (!sameEntry(stored[index], supplied[index])) return false;
  }
  if (supplied.length >= stored.length) return true;
  return (
    stored.length === supplied.length + 1 &&
    stored[stored.length - 1].role === "assistant" &&
    supplied[supplied.length - 1].role === "user"
  );
}

/**
 * Find the conversation this transcript continues.
 *
 * Longest match wins, so a transcript that diverges from a known conversation
 * (an edited or branched message) does NOT silently resume it — the caller
 * starts a new session instead. Two known conversations matching equally well
 * is genuine ambiguity (identical transcripts in different threads), and the
 * only safe reading of that is a new session: picking either one would hand one
 * thread's private turn to the other.
 */
function matchConversation(registry, entries) {
  let best;
  let tied = false;
  for (const entry of registry.values()) {
    if (!continuesConversation(entry.entries, entries)) continue;
    if (!best || entry.entries.length > best.entries.length) {
      best = entry;
      tied = false;
    } else if (entry.entries.length === best.entries.length) {
      tied = true;
    }
  }
  return tied ? undefined : best;
}

// ── runtime ──────────────────────────────────────────────────────────────

function createRuntime({ command, baseArgs, cwd, persona }) {
  const runtime = {
    command,
    baseArgs,
    cwd,
    persona,
    connection: null,
    initialized: null,
    conversations: new Map(),
    queue: Promise.resolve(),
    active: null,
  };
  return runtime;
}

async function ensureConnection(runtime) {
  if (runtime.connection && !runtime.connection.closed) {
    await runtime.initialized;
    return runtime.connection;
  }
  const args = runtime.baseArgs ?? ["acp", "--persona", runtime.persona];
  const connection = new AcpConnection({ command: runtime.command, args, cwd: runtime.cwd });
  connection.onNotification = (message) => {
    if (!message || message.method !== "session/update") return;
    const active = runtime.active;
    if (!active || !message.params) return;
    if (message.params.sessionId && message.params.sessionId !== active.sessionId) return;
    const update = message.params.update;
    if (!update) return;
    if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
      active.text(update.content.text);
    } else if (update.sessionUpdate === "agent_thought_chunk" && update.content?.type === "text") {
      active.reasoning(update.content.text);
    }
    // `tool_call` and `available_commands_update` are presentational. Emitting a
    // tool_call would make OpenCode try to execute a tool Phantombot already
    // ran itself, so they are deliberately dropped.
  };
  runtime.connection = connection;
  runtime.initialized = (async () => {
    const init = await connection.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    connection.capabilities = init?.agentCapabilities ?? {};
    await connection.request("authenticate", { methodId: "none" }).catch(() => {
      // authMethods is empty on the Phantombot side; a rejection here is benign.
    });
    await restoreSessions(runtime, connection);
  })().catch((error) => {
    runtime.connection = null;
    runtime.initialized = null;
    void connection.close();
    throw error;
  });
  await runtime.initialized;
  return connection;
}

/**
 * Re-register this runtime's known sessions on a REPLACEMENT child.
 *
 * The ACP server keeps its session registry in process memory: an id issued by
 * the previous child is unknown to the new one, and `session/prompt` with it is
 * rejected outright. The registry here would otherwise survive the swap and keep
 * handing out dead ids, so every continuation would fail and retrying would not
 * repair the thread.
 *
 * `session/load` is the ACP answer — the server re-derives the conversation key
 * from the token, so the thread resumes verbatim. The replay it streams lands on
 * `connection.onNotification`, where `runtime.active` is null outside a turn and
 * the chunks are dropped; the transcript is already in the client.
 *
 * A session the new child cannot restore is DROPPED, never kept: a missing
 * session costs the thread's context (a fresh session, one turn of history),
 * while a stale id costs every following turn.
 */
async function restoreSessions(runtime, connection) {
  if (runtime.conversations.size === 0) return;
  const canLoad = connection.capabilities?.loadSession === true;
  for (const sessionId of [...runtime.conversations.keys()]) {
    if (!canLoad) {
      runtime.conversations.delete(sessionId);
      continue;
    }
    try {
      await connection.request("session/load", {
        sessionId,
        cwd: runtime.cwd ?? process.cwd(),
      });
    } catch {
      runtime.conversations.delete(sessionId);
    }
  }
}

/** Serialize turns on this runtime: one ACP prompt in flight per child. */
function serialized(runtime, work) {
  const run = runtime.queue.then(work, work);
  runtime.queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Resolve (or create) the ACP session for this transcript, and the turns to send. */
async function prepareTurn(runtime, connection, entries, turns) {
  const known = matchConversation(runtime.conversations, entries);
  if (known && known.sessionId) {
    const pending = entries.slice(known.entries.length);
    // Optimistic: the transcript is adopted as the stored state, and the reply
    // this turn produces is appended once it exists (and dropped if it doesn't,
    // e.g. the turn was cancelled — an answer the client never saw must not be
    // required to appear in the next request).
    known.entries = entries.slice();
    known.touched = Date.now();
    const send = pending.filter((entry) => entry.role === "user").map((entry) => entry.text);
    // A retry of the very same turn replays nothing new; answer it again rather
    // than returning an empty turn.
    return { entry: known, sessionId: known.sessionId, send: send.length > 0 ? send : [turns[turns.length - 1]] };
  }

  const created = await connection.request("session/new", { cwd: runtime.cwd ?? process.cwd(), mcpServers: [] });
  const sessionId = created?.sessionId;
  if (typeof sessionId !== "string") throw new Error("phantombot acp did not return a session id");
  const entry = { sessionId, entries: entries.slice(), touched: Date.now() };
  runtime.conversations.set(sessionId, entry);
  evictConversations(runtime);
  // A brand-new ACP session has no history in Phantombot, so it gets the newest
  // turn only. Anything older is unrecoverable context (a fork, or a session
  // that predates this process) — sending the tail is the honest option.
  return { entry, sessionId, send: [turns[turns.length - 1]] };
}

function evictConversations(runtime) {
  if (runtime.conversations.size <= MAX_CONVERSATIONS) return;
  const oldest = [...runtime.conversations.entries()].sort((a, b) => a[1].touched - b[1].touched).slice(0, 32);
  for (const [key] of oldest) runtime.conversations.delete(key);
}

/**
 * Run one turn and drive the AI SDK stream. Resolves once the stream is closed,
 * whether it ended, failed or was cancelled.
 */
async function runTurn(runtime, { entries, turns, controller, abortSignal }) {
  let textId = 0;
  let lastTextId = null;
  let reasoningId = 0;
  let lastReasoningId = null;
  let reply = "";
  let closed = false;

  const emit = (part) => {
    if (closed) return;
    try {
      controller.enqueue(part);
    } catch {
      closed = true;
    }
  };
  const close = (part) => {
    if (closed) return;
    if (part) {
      try {
        controller.enqueue(part);
      } catch {
        // client went away
      }
    }
    closed = true;
    try {
      controller.close();
    } catch {
      // already closed
    }
  };
  const fail = (error) => {
    close({ type: "error", error: error instanceof Error ? error : new Error(String(error)) });
  };
  const finishCancelled = () => {
    close({
      type: "finish",
      finishReason: { unified: STOP.cancelled, raw: "cancelled" },
      usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } },
    });
  };

  try {
    // A turn that is already aborted must not touch the child at all — spawning a
    // process (or resuming a thread) to answer a request nobody is reading is
    // wasted work at best, and a real agent turn at worst. This also catches the
    // request that was aborted while it waited its turn in the queue below.
    if (abortSignal?.aborted) {
      emit({ type: "stream-start", warnings: [] });
      finishCancelled();
      return;
    }

    const connection = await ensureConnection(runtime);
    const { entry, sessionId, send } = await prepareTurn(runtime, connection, entries, turns);

    emit({ type: "stream-start", warnings: [] });

    // The abort may have landed during initialization or the queue wait, i.e.
    // BEFORE any prompt is in flight. `session/cancel` has nothing to cancel at
    // that point, and letting the prompt through would run the whole agent loop
    // (tools included) only to race a kill timer.
    if (abortSignal?.aborted) {
      finishCancelled();
      return;
    }

    let finish;
    runtime.active = {
      sessionId,
      text(delta) {
        reply += delta;
        if (!lastTextId) {
          lastTextId = `text-${textId++}`;
          emit({ type: "text-start", id: lastTextId });
        }
        emit({ type: "text-delta", id: lastTextId, delta });
      },
      reasoning(delta) {
        if (!lastReasoningId) {
          lastReasoningId = `reasoning-${reasoningId++}`;
          emit({ type: "reasoning-start", id: lastReasoningId });
        }
        emit({ type: "reasoning-delta", id: lastReasoningId, delta });
      },
    };

    const onAbort = () => {
      connection.notify("session/cancel", { sessionId });
      setTimeout(() => {
        // The agent ignored the cancel: kill the child so it stops burning
        // provider tokens with nobody reading its stream.
        if (finish === undefined) void connection.close();
      }, CANCEL_GRACE_MS);
    };
    if (abortSignal) {
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    const result = await connection.request(
      "session/prompt",
      { sessionId, prompt: send.map((text) => ({ type: "text", text })) },
      PROMPT_TIMEOUT_MS,
    );
    finish = result?.stopReason ?? "end_turn";

    if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
    runtime.active = null;

    // Record what we actually said. The next request replays the assistant
    // history, and it is matched against this: a transcript whose assistant
    // turns disagree with it belongs to a different conversation.
    const replyText = reply.replace(SYSTEM_REMINDER, "").trim();
    if (finish !== "cancelled" && replyText) entry.entries = entries.concat([{ role: "assistant", text: replyText }]);

    if (lastReasoningId) {
      emit({ type: "reasoning-end", id: lastReasoningId });
      lastReasoningId = null;
    }
    if (lastTextId) {
      emit({ type: "text-end", id: lastTextId });
      lastTextId = null;
    }
    close({
      type: "finish",
      finishReason: { unified: STOP[finish] ?? "other", raw: finish },
      // ACP carries no token accounting; reporting zeros is honest, and the
      // dashboard shows usage only when a provider supplies it.
      usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } },
    });
  } catch (error) {
    if (lastTextId) emit({ type: "text-end", id: lastTextId });
    if (lastReasoningId) emit({ type: "reasoning-end", id: lastReasoningId });
    runtime.active = null;
    fail(error);
  }
}

function textOnlyStream(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      controller.enqueue({ type: "text-start", id: "text-0" });
      controller.enqueue({ type: "text-delta", id: "text-0", delta: text });
      controller.enqueue({ type: "text-end", id: "text-0" });
      controller.enqueue({
        type: "finish",
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } },
      });
      controller.close();
    },
  });
}

// ── provider factory (the export OpenCode looks for) ─────────────────────

/**
 * Provider factory. OpenCode's `opencode.provider.dynamic` plugin imports this
 * module, picks the first export whose name starts with `create`, and calls it
 * with the flattened provider `settings`.
 *
 * Recognised settings (everything else is ignored):
 *   - `command` — absolute path to the phantombot binary (the installer bakes
 *     this in; PATH lookup is unreliable for GUI-launched editors).
 *   - `args`    — full argv override. Default: `["acp", "--persona", <modelID>]`.
 *   - `cwd`     — working directory for the child. Default: the editor's cwd.
 */
export function createPhantombot(settings = {}) {
  const command = typeof settings.command === "string" && settings.command.trim() ? settings.command.trim() : DEFAULT_COMMAND;
  const baseArgs = Array.isArray(settings.args) ? settings.args.map(String) : undefined;
  const cwd = typeof settings.cwd === "string" && settings.cwd.trim() ? settings.cwd.trim() : undefined;

  function languageModel(modelId) {
    const persona = modelId;
    const key = [command, JSON.stringify(baseArgs ?? null), cwd ?? "", persona].join("\u0000");
    let runtime = runtimes.get(key);
    if (!runtime) {
      runtime = createRuntime({ command, baseArgs, cwd, persona });
      runtimes.set(key, runtime);
    }
    const bound = runtime;

    return {
      specificationVersion: "v3",
      provider: "phantombot",
      modelId,
      supportedUrls: {},

      async doGenerate(options) {
        const { stream } = await this.doStream(options);
        const reader = stream.getReader();
        let text = "";
        let reasoning = "";
        let finishReason = { unified: "other", raw: undefined };
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value.type === "text-delta") text += value.delta;
            else if (value.type === "reasoning-delta") reasoning += value.delta;
            else if (value.type === "finish") finishReason = value.finishReason;
            else if (value.type === "error") throw value.error;
          }
        } finally {
          reader.releaseLock();
        }
        const content = [];
        if (reasoning) content.push({ type: "reasoning", text: reasoning });
        if (text) content.push({ type: "text", text });
        return { content, finishReason, usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } }, warnings: [] };
      },

      async doStream(options) {
        const { system, entries, turns } = readPrompt(options?.prompt);
        if (turns.length === 0) {
          return { stream: textOnlyStream("") };
        }
        if (isTitleRequest(system, turns)) {
          return { stream: textOnlyStream(localTitle(turns)) };
        }
        const abortSignal = options?.abortSignal;
        const stream = new ReadableStream({
          start(controller) {
            void serialized(bound, () => runTurn(bound, { entries, turns, controller, abortSignal }));
          },
          cancel() {
            const sessionId = bound.active?.sessionId;
            if (sessionId) bound.connection?.notify("session/cancel", { sessionId });
          },
        });
        return { stream };
      },
    };
  }

  return { languageModel };
}
