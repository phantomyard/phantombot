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
 *   - WRITES ITS THREAD TOKENS DOWN (issue #710). The registry above dies with
 *     the process, and the ACP server is stateless by design — it re-derives the
 *     conversation key from the token, so a token from a previous process still
 *     reloads the thread from the phantom's own memory store. Persisting the
 *     token is therefore the whole fix for "I reopened an old OpenCode thread and
 *     the phantom had no idea what I was talking about";
 *   - never dispatches a prompt for a turn that was already aborted, whether the
 *     abort landed before the call or while it waited its turn in the queue;
 *   - answers OpenCode's session-title requests locally. OpenCode asks the same
 *     model to name the conversation with the conversation's first user message
 *     as its prompt; sending that to Phantombot would burn a real turn, write a
 *     bogus memory row, and — because its prompt is a prefix of the real first
 *     turn — corrupt the conversation matching below.
 *
 * ## Attachments
 *
 * OpenCode delivers a pasted or attached image as an AI-SDK `file` part and a
 * PDF the same way (base64 `data` + `mediaType`); everything else it rejects
 * before a provider is ever called. Both are preserved:
 *
 *   - images → ACP `image` blocks. The ACP server decodes them into the
 *     workspace inbox and appends `[attached: <path>]`, which is what the
 *     vision path and the harness read.
 *   - PDFs → a content-addressed file under the OS temp dir plus the same
 *     `[attached: <path>]` line, because ACP has no document block.
 *
 * The attachment is part of the turn's IDENTITY (`mediaKey`): two captions that
 * differ only by picture are different turns, so neither is mistaken for a
 * replay of the other. Only the hash is kept in the conversation registry — the
 * payloads are not.
 *
 * Zero dependencies beyond `node:` builtins: no npm install, no build step at
 * install time, nothing for a user to keep in sync.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";

/** Binary spawned when the install did not bake an absolute path in. */
const DEFAULT_COMMAND = "phantombot";

/**
 * Default argv for the child.
 *
 * The `--persona=<id>` SINGLE-ARGUMENT form is load-bearing: Phantombot's CLI
 * (citty) parses the spaced pair `--persona <id>` as the option plus a COMMAND
 * name, so `phantombot acp --persona omar` dies with
 * `Unknown command 'omar'` and every turn in OpenCode fails before
 * `initialize`. Do not "tidy" this into two array entries.
 */
function defaultArgs(persona) {
  return ["acp", `--persona=${persona}`];
}

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
      // Without this a console-subsystem child gets its own conhost window on
      // Windows: the editor is a GUI process, so every turn flashes a black
      // PowerShell-ish console titled with the child's cwd. No-op elsewhere.
      windowsHide: true,
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
 * Where a non-image attachment is spilled so the agent can read it.
 *
 * ACP has no document block: an `image` block is decoded by the server and handed
 * to the harness as `[attached: <path>]`, and everything else can only travel as
 * text. A PDF therefore becomes a real file plus that same `[attached: <path>]`
 * line — the convention Telegram documents already use — which the harness
 * resolves with its own file tools.
 *
 * Content-addressed, so replaying a turn is idempotent and always lands on the
 * same path instead of littering the directory with copies.
 */
const ATTACHMENT_DIR = join(tmpdir(), "phantombot-acp-attachments");
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Base64 payload of a media part, with any `data:` URL prefix removed. */
function base64Of(data) {
  const comma = data.indexOf(",");
  return comma > 0 && data.slice(0, comma).includes("data:") ? data.slice(comma + 1) : data;
}

/**
 * Split one message's content into its text and the media it carries.
 *
 * OpenCode hands an attachment over as an AI-SDK `file` part —
 * `{ type: "file", mediaType, data, filename }` — for images AND for PDFs
 * (verified against OpenCode 2.2.0's bundle: `dy()` maps a user media part to
 * exactly that shape, and a mime that is neither `image/*` nor
 * `application/pdf` is rejected upstream as an unsupported inline attachment).
 *
 * Keeping only `text` parts is what made an attachment vanish, and an
 * attachment with no caption produce no turn at all.
 */
function partsOf(content) {
  if (typeof content === "string") return { text: content, media: [] };
  if (!Array.isArray(content)) return { text: "", media: [] };
  const text = [];
  const media = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") {
      text.push(part.text);
      continue;
    }
    if (part.type !== "file") continue;
    // `data` is base64 for an inline attachment. A provider media REFERENCE is a
    // URL, and ACP cannot carry one — skipping it is honest; forwarding it as an
    // empty attachment would not be.
    if (typeof part.mediaType !== "string" || !part.mediaType) continue;
    if (typeof part.data !== "string" || part.data.length === 0) continue;
    const filename = typeof part.filename === "string" ? part.filename.trim() : "";
    media.push({ mediaType: part.mediaType, data: part.data, filename: filename || undefined });
  }
  return { text: text.join("\n"), media };
}

/**
 * Identity of a turn's attachments, used for transcript matching.
 *
 * Two turns with the same caption but different pictures are DIFFERENT turns; a
 * text-only key would read the second as a replay of the first and answer about
 * the wrong image. The payload is hashed rather than kept, so the conversation
 * registry never holds megabytes of base64 for the life of the process.
 */
function mediaKey(media) {
  if (!Array.isArray(media) || media.length === 0) return "";
  return media
    .map((part) => `${part.mediaType}:${createHash("sha256").update(part.data).digest("hex").slice(0, 16)}`)
    .join(",");
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
    const { text: raw, media } = partsOf(message.content);
    const text = raw.replace(SYSTEM_REMINDER, "").trim();
    // An attachment with no caption is a REAL turn — it is exactly what an
    // image-only prompt looks like, and skipping it is what made pasting a
    // screenshot do nothing at all.
    if (!text && media.length === 0) continue;
    const entry = { role: message.role, text, media, mediaKey: mediaKey(media) };
    entries.push(entry);
    // `turns` stays user-only: it is what gets sent, what the title detector
    // reads, and what decides whether the request is empty.
    if (message.role === "user") turns.push(entry);
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

function localTitle(turn) {
  const words = (turn?.text ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, 6).join(" ");
  const title = words.replace(/[.,;:!?]+$/, "").slice(0, 60);
  return title || "New session";
}

// ── conversation matching ────────────────────────────────────────────────

/**
 * Same message: same role, same text, same attachments. Both sides are
 * reminder-stripped + trimmed, and attachments are compared by their hashed
 * identity rather than by presence.
 */
function sameEntry(a, b) {
  return a.role === b.role && a.text === b.text && (a.mediaKey ?? "") === (b.mediaKey ?? "");
}

/**
 * Does `supplied` extend the transcript `stored`?
 *
 * The whole prior transcript is compared, role included, not just the user
 * turns, and `supplied` must reach at least as far as `stored`:
 *
 *   - every stored entry must appear verbatim at the same index;
 *   - the extra entries are the turns to send.
 *
 * A byte-identical replay qualifies too (it sends the trailing turn again).
 *
 * Everything else is a DIFFERENT conversation and gets a fresh session. That
 * includes the tempting case — `supplied` stopping one entry short of `stored`,
 * at the user turn whose answer `stored` holds — because a retry and a second
 * chat that opens with the same words are the SAME request on the wire. Resuming
 * on that shape is what lets chat B be answered inside chat A's context and walk
 * away with A's private reply; a fresh session costs a retried turn its context,
 * which is recoverable, while the leak is not.
 */
function continuesConversation(stored, supplied) {
  if (stored.length === 0 || supplied.length === 0) return false;
  if (supplied.length < stored.length) return false;
  for (let index = 0; index < stored.length; index += 1) {
    if (!sameEntry(stored[index], supplied[index])) return false;
  }
  return true;
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

function createRuntime({ command, baseArgs, cwd, persona, key }) {
  const runtime = {
    command,
    baseArgs,
    cwd,
    persona,
    /** Spawn identity — what a persisted resume record is scoped to. */
    spawnKey: key ?? "",
    connection: null,
    initialized: null,
    conversations: new Map(),
    /** Resume records read from disk for THIS process; undefined until first use. */
    threads: null,
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
  const args = runtime.baseArgs ?? defaultArgs(runtime.persona);
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

/**
 * The conversation registry keeps matching KEYS, never the attachment payloads:
 * a thread with pictures would otherwise pin their base64 in memory for as long
 * as this process lives.
 */
function forHistory(entries) {
  return entries.map((entry) => ({ role: entry.role, text: entry.text, mediaKey: entry.mediaKey ?? "" }));
}

// ── persisted thread tokens (issue #710) ─────────────────────────────────

/**
 * Where the resume map lives BETWEEN processes.
 *
 * `runtime.conversations` is memory only, and the ACP server keeps no map at all
 * — `mintSessionId` embeds the thread in the token and `conversationForSessionId`
 * re-derives the key from it. So a process restart (OpenCode restart, reboot,
 * upgrade, `acp install opencode`, a model switch that spawns a new runtime)
 * loses only the token → transcript pointer, which is exactly the thing that
 * cannot be recovered: the resume ability is already built server-side.
 *
 * One small JSON file per persona under the user state dir, holding per spawn
 * identity: `{ key, token, digest, length, touched }`. Never a transcript, never
 * an attachment payload — `length` plus `digest` is enough to decide whether an
 * incoming transcript is the one this token represents.
 */
const STATE_SUBDIR = ["phantombot", "opencode-provider"];
const STATE_VERSION = 1;
/** Persisted records are tiny, but they are still bounded — LRU, oldest first. */
const MAX_PERSISTED_THREADS = MAX_CONVERSATIONS;

/** Directory for the resume maps. Read per call: tests point XDG_STATE_HOME at a temp dir. */
function stateDir() {
  const base = process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  return join(base, ...STATE_SUBDIR);
}

function statePathFor(persona) {
  const safe = String(persona ?? "").replace(/[^\w.-]+/g, "_").slice(0, 64) || "default";
  return join(stateDir(), `${safe}.json`);
}

/** Digest of a transcript — role, text and attachment identity, exactly what matching compares. */
function digestOf(entries) {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(`${entry.role}\u0000${entry.text}\u0000${entry.mediaKey ?? ""}\n`);
  }
  return hash.digest("hex");
}

/** Records that survived a restart, for THIS process. Corrupt/missing ⇒ empty. */
async function loadThreads(runtime) {
  if (runtime.threads) return runtime.threads;
  const records = [];
  try {
    const parsed = JSON.parse(await readFile(statePathFor(runtime.persona), "utf8"));
    if (parsed?.version === STATE_VERSION && Array.isArray(parsed.threads)) {
      for (const record of parsed.threads) {
        if (!record || typeof record !== "object") continue;
        if (typeof record.key !== "string" || typeof record.token !== "string") continue;
        if (typeof record.digest !== "string" || !Number.isSafeInteger(record.length)) continue;
        if (record.length < 1) continue;
        records.push({
          key: record.key,
          token: record.token,
          digest: record.digest,
          length: record.length,
          touched: Number(record.touched) || 0,
        });
      }
    }
  } catch {
    // Missing, unreadable or corrupt: an empty map. Losing the pointer costs a
    // thread its context; throwing here would cost every thread every turn.
  }
  runtime.threads = records;
  return records;
}

/** Persist the resume map. Best-effort — a read-only HOME must not fail a turn. */
async function saveThreads(runtime) {
  const records = runtime.threads ?? [];
  if (records.length > MAX_PERSISTED_THREADS) {
    runtime.threads = records
      .slice()
      .sort((a, b) => b.touched - a.touched)
      .slice(0, MAX_PERSISTED_THREADS);
  }
  const path = statePathFor(runtime.persona);
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temp, `${JSON.stringify({ version: STATE_VERSION, threads: runtime.threads ?? [] })}\n`);
    // Rename, never in-place: a reader must not see a half-written map and
    // conclude the thread's token is gone.
    await rename(temp, path);
  } catch {
    await unlink(temp).catch(() => {});
  }
}

/** Remember which token this thread must resume from after a restart. */
async function rememberThread(runtime, entry) {
  const records = await loadThreads(runtime);
  const record = {
    key: runtime.spawnKey,
    token: entry.sessionId,
    digest: digestOf(entry.entries),
    length: entry.entries.length,
    touched: Date.now(),
  };
  const at = records.findIndex((item) => item.key === record.key && item.token === record.token);
  if (at === -1) records.push(record);
  else records[at] = record;
  await saveThreads(runtime);
}

/** Drop a record the server refused, so the next turn does not retry a dead token. */
async function forgetThread(runtime, token) {
  const records = await loadThreads(runtime);
  const at = records.findIndex((item) => item.key === runtime.spawnKey && item.token === token);
  if (at === -1) return;
  records.splice(at, 1);
  await saveThreads(runtime);
}

/**
 * Resume this transcript on the token a PREVIOUS process wrote down.
 *
 * The token is reused only when the incoming transcript EXTENDS the one it
 * represents — the same prefix rule `continuesConversation` applies in memory,
 * re-derived from the digest. A fork, an edited turn or a different thread falls
 * through to `session/new`. Two records matching equally well is genuine
 * ambiguity (identical transcripts in different threads) and also falls through:
 * picking either would hand one thread's private history to the other.
 */
async function resumeThread(runtime, connection, entries, turns) {
  const records = (await loadThreads(runtime)).filter((record) => record.key === runtime.spawnKey);
  if (records.length === 0) return undefined;
  // A child that cannot load sessions would reject the id and then every prompt
  // with it — ask before relying on it.
  if (connection.capabilities?.loadSession !== true) return undefined;

  let best;
  let tied = false;
  for (const record of records) {
    if (record.length > entries.length) continue;
    if (digestOf(entries.slice(0, record.length)) !== record.digest) continue;
    if (!best || record.length > best.length) {
      best = record;
      tied = false;
    } else if (record.length === best.length) {
      tied = true;
    }
  }
  if (!best || tied) return undefined;

  try {
    await connection.request("session/load", {
      sessionId: best.token,
      cwd: runtime.cwd ?? process.cwd(),
    });
  } catch {
    // The server refused the token (upgrade, wiped memory, another persona's
    // thread): forget it rather than paying for the attempt on every turn.
    await forgetThread(runtime, best.token);
    return undefined;
  }

  const entry = { sessionId: best.token, entries: forHistory(entries), touched: Date.now() };
  runtime.conversations.set(entry.sessionId, entry);
  await rememberThread(runtime, entry);
  // `session/load` already replayed this thread from the phantom's own memory
  // store, so the whole transcript is in context: send only what the client
  // added since (and the current turn when nothing was added).
  const pending = entries.slice(best.length).filter((item) => item.role === "user");
  return { entry, sessionId: entry.sessionId, send: pending.length > 0 ? pending : [turns[turns.length - 1]] };
}

// ── recap seeding (defence in depth) ─────────────────────────────────────

/** Bounds on the recap prefix: a few hundred tokens, never the whole thread. */
const RECAP_MAX_CHARS = 4000;
const RECAP_MAX_TURNS = 8;
const RECAP_TURN_CHARS = 400;

/**
 * What to send when a thread could NOT be resumed (stale/corrupt state file, a
 * thread from another machine, a genuinely forked transcript).
 *
 * Sending the newest turn alone is what made "pick this up" answer "what are you
 * referring to?" while the whole thread was on screen. A bounded recap costs a
 * few hundred tokens and is honest context.
 *
 * The guard is the safety-critical part: a genuinely NEW chat always arrives as
 * exactly one user entry and no assistant entries, so it can never be seeded
 * with another thread's words — the same leak `continuesConversation` refuses to
 * make. The recap is a PROMPT prefix only; the registry keeps the original text,
 * so the next request (which replays the original) still matches.
 */
function seedTurns(entries, turns) {
  const last = turns[turns.length - 1];
  if (!last) return [];
  const prior = entries.slice(0, -1);
  if (!prior.some((entry) => entry.role === "assistant")) return [last];

  const lineOf = (entry) => {
    const body = String(entry.text ?? "").replace(/\s+/g, " ").trim().slice(0, RECAP_TURN_CHARS);
    return `${entry.role}: ${body || "[attachment]"}`;
  };

  // Build from the newest backwards so the freshest turns are the ones that
  // survive the cap, then restore order.
  const recent = [];
  let used = 0;
  for (let index = prior.length - 1; index >= 0 && recent.length < RECAP_MAX_TURNS; index -= 1) {
    const line = lineOf(prior[index]);
    if (used + line.length > RECAP_MAX_CHARS) break;
    used += line.length;
    recent.unshift(line);
  }
  const opening = prior.find((entry) => entry.role === "user");
  if (opening && !recent.includes(lineOf(opening))) {
    const line = lineOf(opening);
    if (used + line.length <= RECAP_MAX_CHARS) recent.unshift(line);
  }
  if (recent.length === 0) return [last];

  const recap = [
    "<earlier-turns>",
    "Earlier turns of this OpenCode thread, for context only. Do not answer",
    "them; answer only the final message.",
    ...recent,
    "</earlier-turns>",
  ].join("\n");
  return [{ ...last, text: `${recap}\n\n${last.text}` }];
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
    known.entries = forHistory(entries);
    known.touched = Date.now();
    await rememberThread(runtime, known);
    const send = pending.filter((entry) => entry.role === "user");
    // A byte-identical replay (the client re-sending the whole transcript) has
    // nothing new in it; answer the last turn again rather than returning an
    // empty reply. Attachments ride along — re-sending the text alone would
    // answer about an image the agent can no longer see.
    return { entry: known, sessionId: known.sessionId, send: send.length > 0 ? send : [turns[turns.length - 1]] };
  }

  // Cold registry: this process is new (restart, reboot, upgrade), the entry was
  // evicted, or the transcript is from a thread this instance never saw. The
  // token written down last time still names the thread — the ACP server derives
  // the conversation key from the token — so resume BEFORE spending the context.
  const resumed = await resumeThread(runtime, connection, entries, turns);
  if (resumed) return resumed;

  const created = await connection.request("session/new", { cwd: runtime.cwd ?? process.cwd(), mcpServers: [] });
  const sessionId = created?.sessionId;
  if (typeof sessionId !== "string") throw new Error("phantombot acp did not return a session id");
  const entry = { sessionId, entries: forHistory(entries), touched: Date.now() };
  runtime.conversations.set(sessionId, entry);
  evictConversations(runtime);
  await rememberThread(runtime, entry);
  // A brand-new ACP session has no history in Phantombot, so it gets the newest
  // turn — plus a bounded recap when the transcript carries earlier assistant
  // turns, i.e. when this is an old thread that could not be resumed.
  return { entry, sessionId, send: seedTurns(entries, turns) };
}

function evictConversations(runtime) {
  if (runtime.conversations.size <= MAX_CONVERSATIONS) return;
  const oldest = [...runtime.conversations.entries()].sort((a, b) => a[1].touched - b[1].touched).slice(0, 32);
  // The persisted resume record is deliberately KEPT: it is what lets an evicted
  // thread come back with its history instead of starting over. It is a token
  // and a digest, already LRU-capped on its own (MAX_PERSISTED_THREADS), so
  // dropping it here would undo the very fix this is for.
  for (const [key] of oldest) runtime.conversations.delete(key);
}

/**
 * Translate turns into ACP content blocks.
 *
 * Images go through as `image` blocks: the ACP server decodes them into the
 * workspace inbox and appends the `[attached: <path>]` line that both the vision
 * path and the harness understand. A PDF has no ACP block, so it is spilled to a
 * file and announced with the same line. Text keeps its original position.
 */
async function promptBlocks(entries) {
  const blocks = [];
  for (const entry of entries) {
    if (entry?.text) blocks.push({ type: "text", text: entry.text });
    for (const part of entry?.media ?? []) blocks.push(await attachmentBlock(part));
  }
  return blocks;
}

/** A filename we can join onto the attachment directory: no separators, no dots. */
function safeFilename(filename) {
  const base = String(filename ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[^\w.-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 80);
  if (!cleaned) return "document.pdf";
  return extname(cleaned) ? cleaned : `${cleaned}.pdf`;
}

/** One attachment part → the ACP block that carries it. */
async function attachmentBlock(part) {
  if (part.mediaType.startsWith("image/")) {
    return { type: "image", data: base64Of(part.data), mimeType: part.mediaType };
  }
  const label = part.filename ?? part.mediaType;
  if (part.mediaType !== "application/pdf") {
    // OpenCode rejects these before we see them; say so rather than dropping the
    // attachment silently if that ever changes.
    return {
      type: "text",
      text: `[attached ${label} could not be forwarded: Phantombot takes images, PDFs and text files]`,
    };
  }
  try {
    const bytes = Buffer.from(base64Of(part.data), "base64");
    if (bytes.byteLength === 0) return { type: "text", text: "[attached PDF was empty / undecodable]" };
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      const mb = (bytes.byteLength / 1024 / 1024).toFixed(1);
      return {
        type: "text",
        text: `[attached PDF too large to forward: ${mb} MB > ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB cap]`,
      };
    }
    const sha = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const path = join(ATTACHMENT_DIR, `${sha}-${safeFilename(part.filename)}`);
    await mkdir(ATTACHMENT_DIR, { recursive: true });
    await writeFile(path, bytes);
    return { type: "text", text: `[attached: ${path}]` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { type: "text", text: `[attached PDF couldn't be saved: ${reason}]` };
  }
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
      { sessionId, prompt: await promptBlocks(send) },
      PROMPT_TIMEOUT_MS,
    );
    finish = result?.stopReason ?? "end_turn";

    if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
    runtime.active = null;

    // Record what we actually said. The next request replays the assistant
    // history, and it is matched against this: a transcript whose assistant
    // turns disagree with it belongs to a different conversation.
    const replyText = reply.replace(SYSTEM_REMINDER, "").trim();
    if (finish !== "cancelled" && replyText) {
      entry.entries = forHistory(entries).concat([{ role: "assistant", text: replyText, mediaKey: "" }]);
      // Persist the transcript WITH the reply: that is what the next request
      // replays, so it is what the resume record's digest must describe.
      await rememberThread(runtime, entry);
    }

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
      runtime = createRuntime({ command, baseArgs, cwd, persona, key });
      runtimes.set(key, runtime);
    }
    const bound = runtime;

    /**
     * The one place a request turns into an ACP turn. Defined as a local
     * function, not a method: `doGenerate` folds the same stream, and reaching
     * for `this.doStream` would break the moment either is detached or called
     * with a different receiver.
     */
    const doStream = async (options) => {
      const { system, entries, turns } = readPrompt(options?.prompt);
      if (turns.length === 0) {
        return { stream: textOnlyStream("") };
      }
      if (isTitleRequest(system, turns)) {
        return { stream: textOnlyStream(localTitle(turns[0])) };
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
    };

    return {
      specificationVersion: "v3",
      provider: "phantombot",
      modelId,
      supportedUrls: {},

      async doGenerate(options) {
        const { stream } = await doStream(options);
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

      doStream,
    };
  }

  return { languageModel };
}
