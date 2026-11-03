/**
 * PhantomChat Local PC tools, phantom side (issue #747).
 *
 * The principal's PhantomChat desktop app can lend this persona tools that run
 * on that PC (bash, read, write, edit, ls, find, grep), once the principal has
 * turned the contact's "Local tools" switch ON there. The wire protocol is the
 * one reviewed in phantomchat#405 (docs/EXTERNAL-AI.md, #276):
 *
 *   NIP-17 rumors carrying BOTH tags ["phantomchat-local-tools", "1"] and
 *   ["control", "true"], with JSON content whose `type` is
 *   "phantomchat-local-tools". Sent to the other party only — no self copy.
 *
 *   phantom → app:  {t:"hello"} · {t:"call", callId, deviceId, tool, args,
 *                   expiresAt, timeoutMs?, groupId?} · {t:"cancel", callId}
 *   app → phantom:  {t:"capability", deviceId, deviceName, platform, tools}
 *                   {t:"revoked", deviceId}
 *                   {t:"result", callId, seq, total, data}  — join `data`
 *                   across seq, then parse {status, output, exit?, truncated?}
 *
 * The app answers only an npub whose switch is ON, so silence means "no
 * device". Trust is the npub pairing (the app's contact + this persona's
 * allowed_npubs): only allow-listed principals are ever addressed, and only
 * their answers are read. Nothing here runs a turn; the daemon's channel drops
 * these rumors before its turn pipeline (`isLocalToolsRumor`).
 *
 * This module is stateless and listener-free: `phantombot device` opens its
 * own short-lived pool as the persona (like `phantombot notify`), so it works
 * from any harness with a shell, with or without a running daemon.
 */

import { randomBytes } from "node:crypto";

import {
  createGiftWrap,
  createRumor,
  createSeal,
  isV2Event,
  type NTNostrEvent,
  unwrapNip17Message,
  unwrapV2,
} from "../../lib/nostrCrypto.ts";

export const LOCAL_TOOLS_TAG = ["phantomchat-local-tools", "1"] as const;
export const CONTROL_TAG = ["control", "true"] as const;
export const LOCAL_TOOLS_TYPE = "phantomchat-local-tools";

/** The tools the app can lend (EXTERNAL-AI.md). */
export const LOCAL_TOOLS = ["bash", "read", "write", "edit", "ls", "find", "grep"] as const;
export type LocalTool = (typeof LOCAL_TOOLS)[number];

/**
 * Each tool's arguments (Pi's built-in tool schemas, which the desktop runs).
 * Help text only: the app validates.
 */
export const LOCAL_TOOL_ARGS: Record<LocalTool, string> = {
  bash: '{"command", "timeout"?}',
  read: '{"path", "offset"?, "limit"?}',
  write: '{"path", "content"}',
  edit: '{"path", "edits": [{"oldText", "newText"}]}',
  ls: '{"path"?, "limit"?}',
  find: '{"pattern", "path"?, "limit"?}',
  grep: '{"pattern", "path"?, "glob"?, "ignoreCase"?, "literal"?, "context"?, "limit"?}',
};

const CALL_ID = /^[\w-]{1,64}$/;
const DEVICE_ID = /^[0-9a-f]{32}$/i;
/** Protocol ceilings: a call expires at most 10 minutes ahead and runs at most 10. */
export const MAX_CALL_MS = 10 * 60_000;
export const DEFAULT_CALL_TIMEOUT_MS = 2 * 60_000;

export interface DeviceCapability {
  /** Hex pubkey of the principal whose app sent it. */
  ownerHex: string;
  deviceId: string;
  deviceName: string;
  platform: string;
  tools: LocalTool[];
}

export interface ToolResult {
  status: "ok" | "error" | "cancelled" | "timeout";
  output: string;
  exit?: number;
  truncated?: boolean;
}

export type AppMessage =
  | { t: "capability"; deviceId: string; deviceName: string; platform: string; tools: LocalTool[] }
  | { t: "revoked"; deviceId: string }
  | { t: "result"; callId: string; seq: number; total: number; data: string };

export type PhantomMessage =
  | { t: "hello" }
  | {
      t: "call";
      callId: string;
      deviceId: string;
      tool: LocalTool;
      args: Record<string, unknown>;
      expiresAt: number;
      timeoutMs?: number;
      groupId?: string;
    }
  | { t: "cancel"; callId: string };

function hasTag(tags: unknown, tag: readonly string[]): boolean {
  return (
    Array.isArray(tags) &&
    tags.some((t) => Array.isArray(t) && t[0] === tag[0] && t[1] === tag[1])
  );
}

/**
 * True for a Local PC tools control rumor. Keyed on the TAGS, not the content,
 * so a malformed body is still recognised (and dropped) rather than falling
 * through to the plain-text path and becoming a turn.
 */
export function isLocalToolsRumor(rumor: { tags?: unknown }): boolean {
  return hasTag(rumor.tags, LOCAL_TOOLS_TAG) && hasTag(rumor.tags, CONTROL_TAG);
}

/** Parse one app → phantom message; undefined for anything malformed or unknown. */
export function parseAppMessage(content: string): AppMessage | undefined {
  let p: Record<string, unknown>;
  try {
    const v = JSON.parse(content);
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    p = v as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (p.type !== LOCAL_TOOLS_TYPE) return undefined;
  const deviceId = typeof p.deviceId === "string" && DEVICE_ID.test(p.deviceId) ? p.deviceId.toLowerCase() : undefined;
  switch (p.t) {
    case "capability": {
      if (!deviceId || !Array.isArray(p.tools)) return undefined;
      const tools = p.tools.filter((x): x is LocalTool =>
        typeof x === "string" && (LOCAL_TOOLS as readonly string[]).includes(x),
      );
      return {
        t: "capability",
        deviceId,
        deviceName: typeof p.deviceName === "string" ? p.deviceName.slice(0, 128) : "",
        platform: typeof p.platform === "string" ? p.platform.slice(0, 32) : "",
        tools,
      };
    }
    case "revoked":
      return deviceId ? { t: "revoked", deviceId } : undefined;
    case "result": {
      const { callId, seq, total, data } = p;
      if (typeof callId !== "string" || !CALL_ID.test(callId)) return undefined;
      if (!Number.isInteger(total) || (total as number) < 1 || (total as number) > 10_000) return undefined;
      if (!Number.isInteger(seq) || (seq as number) < 0 || (seq as number) >= (total as number)) return undefined;
      if (typeof data !== "string") return undefined;
      return { t: "result", callId, seq: seq as number, total: total as number, data };
    }
    default:
      return undefined;
  }
}

/** Parse the joined `data` of a result; a malformed body is an error result. */
export function parseToolResult(data: string): ToolResult {
  try {
    const v = JSON.parse(data) as Record<string, unknown>;
    const status = v.status;
    if (status === "ok" || status === "error" || status === "cancelled" || status === "timeout") {
      return {
        status,
        output: typeof v.output === "string" ? v.output : "",
        ...(typeof v.exit === "number" ? { exit: v.exit } : {}),
        ...(typeof v.truncated === "boolean" ? { truncated: v.truncated } : {}),
      };
    }
  } catch {
    /* fall through */
  }
  return { status: "error", output: "malformed result from the device" };
}

/** A fresh call id: 24 url-safe chars, inside the protocol's [\w-]{1,64}. */
export function newCallId(): string {
  return randomBytes(18).toString("base64url");
}

/**
 * Build a validated `call`. Throws on anything the app would refuse anyway,
 * so the caller gets a clear error instead of silence.
 */
export function buildCall(input: {
  deviceId: string;
  tool: string;
  args: unknown;
  timeoutMs?: number;
  groupId?: string;
  callId?: string;
  now?: number;
}): Extract<PhantomMessage, { t: "call" }> {
  if (!(LOCAL_TOOLS as readonly string[]).includes(input.tool)) {
    throw new Error(`unknown tool '${input.tool}' (one of: ${LOCAL_TOOLS.join(", ")})`);
  }
  if (!DEVICE_ID.test(input.deviceId)) throw new Error(`not a device id: ${input.deviceId}`);
  if (!input.args || typeof input.args !== "object" || Array.isArray(input.args)) {
    throw new Error("args must be a JSON object, e.g. {\"command\":\"ls\"}");
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_CALL_MS) {
    throw new Error(`timeout must be 1 ms .. ${MAX_CALL_MS / 60_000} minutes`);
  }
  const callId = input.callId ?? newCallId();
  if (!CALL_ID.test(callId)) throw new Error(`bad call id: ${callId}`);
  const now = input.now ?? Date.now();
  return {
    t: "call",
    callId,
    deviceId: input.deviceId.toLowerCase(),
    tool: input.tool as LocalTool,
    args: input.args as Record<string, unknown>,
    // The app refuses a call that expires more than 10 minutes ahead; the
    // call can't outlive its own timeout, so that is the expiry.
    expiresAt: now + timeoutMs,
    timeoutMs,
    ...(input.groupId ? { groupId: input.groupId } : {}),
  };
}

/**
 * Gift-wrap one phantom → app message for `recipientHex` ONLY (no self copy:
 * the protocol forbids it, and a self copy would reach our own listener).
 */
export function wrapLocalTools(
  senderSk: Uint8Array,
  recipientHex: string,
  message: PhantomMessage,
): NTNostrEvent {
  const content = JSON.stringify({ type: LOCAL_TOOLS_TYPE, ...message });
  const rumor = createRumor(content, senderSk, [
    ["p", recipientHex],
    [...LOCAL_TOOLS_TAG],
    [...CONTROL_TAG],
  ]);
  const seal = createSeal(rumor, senderSk, recipientHex);
  return createGiftWrap(seal, recipientHex) as unknown as NTNostrEvent;
}

/** The pool surface we use (AuthGuardedSimplePool and test doubles). */
export interface LocalToolsPool {
  subscribeMany(
    relays: string[],
    filter: Record<string, unknown>,
    params: { onevent?: (event: NTNostrEvent) => void; oneose?: () => void },
  ): { close(): void };
  publish(relays: string[], event: NTNostrEvent): Promise<unknown>[];
  close(relays?: string[]): void;
}

export interface LocalToolsClientOptions {
  secretKey: Uint8Array;
  publicKeyHex: string;
  relays: string[];
  /** Allow-listed principals (lowercase hex). Only they are addressed and heard. */
  principalsHex: string[];
  pool: LocalToolsPool;
  now?: () => number;
}

/** How far behind our clock a device's capability/revoked may be stamped (seconds). */
export const FRESHNESS_WINDOW_S = 5 * 60;

/**
 * One short-lived session as the persona: subscribe to our inbox, address the
 * principals' apps, read their answers. Close it when done.
 */
export class LocalToolsClient {
  readonly devices = new Map<string, DeviceCapability>();
  #opts: LocalToolsClientOptions;
  #sub: { close(): void } | undefined;
  #principals: Set<string>;
  #since: number;
  /** Newest capability/revoked time seen per device, so a late older one can't undo a newer one. */
  #deviceAt = new Map<string, { at: number; revoked: boolean }>();
  #seen = new Set<string>();
  #results = new Map<
    string,
    { ownerHex: string; total: number; parts: Map<number, string>; done: (r: ToolResult) => void }
  >();
  #deviceListeners = new Set<() => void>();

  constructor(opts: LocalToolsClientOptions) {
    this.#opts = opts;
    this.#principals = new Set(opts.principalsHex.map((h) => h.toLowerCase()));
    // Capability/revoked rumors are stamped by the DEVICE's clock, so the
    // window must tolerate clock skew (and a laptop just out of sleep): a
    // minutes-scale cutoff, not seconds. Old sessions beyond it are ignored;
    // within it, per-device ordering (#deviceAt) keeps a newer revoked from
    // being undone by an older capability. Results need no time check: they
    // are bound to a live random callId and to the device that was called.
    this.#since = Math.floor((opts.now?.() ?? Date.now()) / 1000) - FRESHNESS_WINDOW_S;
  }

  open(): void {
    if (this.#sub) return;
    this.#sub = this.#opts.pool.subscribeMany(
      this.#opts.relays,
      // NIP-59 lets a wrap's created_at sit up to two days in the past, so the
      // relay filter is wide and the rumor's own time is checked instead.
      { kinds: [1059], "#p": [this.#opts.publicKeyHex], since: this.#since - 2 * 86_400 },
      { onevent: (ev) => void this.#onWrap(ev) },
    );
  }

  async #onWrap(event: NTNostrEvent): Promise<void> {
    if (this.#seen.has(event.id)) return;
    this.#seen.add(event.id);
    let rumor: { pubkey: string; tags?: unknown; content: string; created_at: number };
    try {
      rumor = isV2Event(event)
        ? await unwrapV2(event, this.#opts.secretKey)
        : unwrapNip17Message(event, this.#opts.secretKey);
    } catch {
      return; // unverifiable or not for us
    }
    const sender = rumor.pubkey.toLowerCase();
    if (!this.#principals.has(sender)) return;
    if (!isLocalToolsRumor(rumor)) return;
    const msg = parseAppMessage(rumor.content);
    if (!msg) return;
    if (msg.t === "capability" || msg.t === "revoked") {
      if (rumor.created_at < this.#since) return;
      const key = `${sender}\0${msg.deviceId}`;
      const last = this.#deviceAt.get(key);
      // Same-second tie: a revoke wins, so the switch going OFF is never lost.
      if (last && (rumor.created_at < last.at || (rumor.created_at === last.at && last.revoked))) return;
      this.#deviceAt.set(key, { at: rumor.created_at, revoked: msg.t === "revoked" });
    }
    if (msg.t === "capability") {
      this.devices.set(msg.deviceId, {
        ownerHex: sender,
        deviceId: msg.deviceId,
        deviceName: msg.deviceName,
        platform: msg.platform,
        tools: msg.tools,
      });
      for (const l of [...this.#deviceListeners]) l();
    } else if (msg.t === "revoked") {
      const d = this.devices.get(msg.deviceId);
      if (d && d.ownerHex === sender) this.devices.delete(msg.deviceId);
      for (const l of [...this.#deviceListeners]) l();
    } else {
      // Only the device we called may answer it: a result for our call id
      // from another principal's app is ignored.
      const pending = this.#results.get(msg.callId);
      if (!pending || pending.ownerHex !== sender) return;
      if (pending.parts.size === 0) pending.total = msg.total;
      else if (msg.total !== pending.total) return;
      pending.parts.set(msg.seq, msg.data);
      if (pending.parts.size === pending.total) {
        let data = "";
        for (let i = 0; i < pending.total; i++) data += pending.parts.get(i) ?? "";
        this.#results.delete(msg.callId);
        pending.done(parseToolResult(data));
      }
    }
  }

  async #send(recipientHex: string, message: PhantomMessage): Promise<void> {
    const wrap = wrapLocalTools(this.#opts.secretKey, recipientHex, message);
    // Resolve on the first relay accept, like the channel's sends.
    await Promise.any(this.#opts.pool.publish(this.#opts.relays, wrap)).catch(() => {
      throw new Error("no relay accepted the message");
    });
  }

  /**
   * Say hello to every principal's app and collect capabilities for `waitMs`.
   * Resolves early once `untilDevice` (an id or name) has answered.
   */
  async discover(waitMs: number, untilDevice?: string): Promise<DeviceCapability[]> {
    this.open();
    const found = () => (untilDevice ? findDevice([...this.devices.values()], untilDevice) : undefined);
    await Promise.all([...this.#principals].map((p) => this.#send(p, { t: "hello" })));
    if (!found()) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, waitMs);
        const listener = () => {
          if (found()) done();
        };
        function done() {
          clearTimeout(timer);
          resolve();
        }
        this.#deviceListeners.add(listener);
        setTimeout(() => this.#deviceListeners.delete(listener), waitMs + 10);
      });
    }
    return [...this.devices.values()];
  }

  /**
   * Run one tool on `device`. Resolves with the device's result; with
   * `{status:"timeout"}` when nothing came back in time (the device is gone),
   * and `{status:"cancelled"}` when `signal` aborts (a cancel is sent).
   */
  async call(
    device: DeviceCapability,
    tool: string,
    args: unknown,
    options: { timeoutMs?: number; groupId?: string; graceMs?: number; signal?: AbortSignal } = {},
  ): Promise<ToolResult> {
    if (!device.tools.includes(tool as LocalTool)) {
      throw new Error(`device '${device.deviceName || device.deviceId}' does not offer '${tool}'`);
    }
    const call = buildCall({
      deviceId: device.deviceId,
      tool,
      args,
      timeoutMs: options.timeoutMs,
      groupId: options.groupId,
      now: this.#opts.now?.(),
    });
    this.open();
    const result = new Promise<ToolResult>((resolve) => {
      this.#results.set(call.callId, { ownerHex: device.ownerHex, total: 0, parts: new Map(), done: resolve });
    });
    await this.#send(device.ownerHex, call);
    const grace = options.graceMs ?? 15_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<ToolResult>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            status: "timeout",
            output: `no answer from device '${device.deviceName || device.deviceId}' — treat it as unavailable`,
          }),
        (call.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS) + grace,
      );
    });
    const cancelled = new Promise<ToolResult>((resolve) => {
      const onAbort = () => {
        void this.#send(device.ownerHex, { t: "cancel", callId: call.callId }).catch(() => {});
        resolve({ status: "cancelled", output: "cancelled" });
      };
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([result, timedOut, cancelled]);
    } finally {
      clearTimeout(timer);
      this.#results.delete(call.callId);
    }
  }

  close(): void {
    this.#sub?.close();
    this.#sub = undefined;
    this.#deviceListeners.clear();
  }
}

/** Find a device by id or (case-insensitive) name. A name shared by two devices matches neither. */
export function findDevice(devices: DeviceCapability[], ref: string): DeviceCapability | undefined {
  const r = ref.trim().toLowerCase();
  const byId = devices.find((d) => d.deviceId === r);
  if (byId) return byId;
  const byName = devices.filter((d) => d.deviceName.toLowerCase() === r);
  return byName.length === 1 ? byName[0] : undefined;
}

/** The group id for a call made from `conversation`, if it is a PhantomChat group chat. */
export function groupIdForConversation(conversation: string | undefined): string | undefined {
  const prefix = "phantomchat:group:";
  if (!conversation?.startsWith(prefix)) return undefined;
  const id = conversation.slice(prefix.length);
  return id.length > 0 ? id : undefined;
}
