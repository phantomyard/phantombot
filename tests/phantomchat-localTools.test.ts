/**
 * PhantomChat Local PC tools, phantom side (#747): the protocol module and
 * `phantombot device`. The desktop app is played by FakeApp over a fake relay
 * pool, with real NIP-17 gift-wraps in both directions, speaking the protocol
 * from phantomchat's docs/EXTERNAL-AI.md (#405).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDeviceCall, runDeviceList, untrustedReason } from "../src/cli/device.ts";
import type { Config } from "../src/config.ts";
import {
  buildCall,
  CONTROL_TAG,
  groupIdForConversation,
  isLocalToolsRumor,
  LOCAL_TOOLS_TAG,
  LOCAL_TOOLS_TYPE,
  parseAppMessage,
  parseToolResult,
} from "../src/channels/phantomchat/localTools.ts";
import { savePhantomchatPersonaConfig } from "../src/channels/phantomchat/personaStore.ts";
import { generateIdentity } from "../src/lib/nostrIdentity.ts";
import {
  createGiftWrap,
  createRumor,
  createSeal,
  type NTNostrEvent,
  unwrapNip17Message,
} from "../src/lib/nostrCrypto.ts";

type Id = ReturnType<typeof generateIdentity>;
type OnEvent = (e: NTNostrEvent) => void;

const DEVICE = "0123456789abcdef0123456789abcdef";
const RELAYS = ["wss://relay.test"];

/** An app → phantom wrap, exactly as the desktop sends it. */
function appWrap(from: Id, toHex: string, body: Record<string, unknown>, tags = true): NTNostrEvent {
  const rumor = createRumor(JSON.stringify({ type: LOCAL_TOOLS_TYPE, ...body }), from.secretKey, [
    ["p", toHex],
    ...(tags ? [[...LOCAL_TOOLS_TAG], [...CONTROL_TAG]] : []),
  ]);
  return createGiftWrap(createSeal(rumor, from.secretKey, toHex), toHex) as unknown as NTNostrEvent;
}

/**
 * The relay pool AND the principal's desktop app. Publishing a wrap addressed
 * to `app.identity` makes the app read it and answer like phantomchat's
 * localAiHost: capability on hello (if its switch is ON), a chunked result on
 * call, nothing at all when the switch is OFF.
 */
class FakeApp {
  subscribers: OnEvent[] = [];
  received: Array<{ to: string; tags: string[][]; body: Record<string, unknown> }> = [];
  published = 0;
  switchOn = true;
  /** Answer calls (false = the PC went away mid-call). */
  answerCalls = true;
  constructor(
    readonly identity: Id,
    readonly personaHex: () => string,
  ) {}
  subscribeMany(_r: string[], _f: unknown, params: { onevent?: OnEvent }) {
    if (params.onevent) this.subscribers.push(params.onevent);
    return { close: () => {} };
  }
  publish(_r: string[], event: NTNostrEvent) {
    this.published++;
    const to = event.tags.find((t) => t[0] === "p")?.[1] ?? "";
    if (to === this.identity.publicKeyHex) queueMicrotask(() => this.#read(event));
    return [Promise.resolve("ok")];
  }
  close() {}
  deliver(e: NTNostrEvent) {
    for (const s of this.subscribers) s(e);
  }
  #read(event: NTNostrEvent) {
    const rumor = unwrapNip17Message(event, this.identity.secretKey);
    const body = JSON.parse(rumor.content) as Record<string, unknown>;
    this.received.push({ to: event.tags[0]![1]!, tags: rumor.tags, body });
    if (!this.switchOn) return;
    const reply = (b: Record<string, unknown>) => this.deliver(appWrap(this.identity, this.personaHex(), b));
    if (body.t === "hello") {
      reply({ t: "capability", deviceId: DEVICE, deviceName: "Desk", platform: "linux", tools: ["bash", "read"] });
    } else if (body.t === "call" && this.answerCalls) {
      const data = JSON.stringify({ status: "ok", output: `ran ${JSON.stringify(body.args)}`, exit: 0 });
      const half = Math.floor(data.length / 2);
      // Out of order, as relays may deliver them.
      reply({ t: "result", callId: body.callId, seq: 1, total: 2, data: data.slice(half) });
      reply({ t: "result", callId: body.callId, seq: 0, total: 2, data: data.slice(0, half) });
    }
  }
}

let root: string;
let config: Config;
let persona: Id;
let owner: Id;
let app: FakeApp;

function sink(): ((s: string) => void) & { text: string } {
  const fn = ((s: string) => {
    fn.text += s;
  }) as ((s: string) => void) & { text: string };
  fn.text = "";
  return fn;
}

const ENV = { PHANTOMBOT_PERSONA: "ana" } as NodeJS.ProcessEnv;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "pb-localtools-"));
  config = { personasDir: join(root, "personas"), defaultPersona: "ana" } as unknown as Config;
  mkdirSync(join(config.personasDir, "ana"), { recursive: true });
  persona = generateIdentity();
  owner = generateIdentity();
  await savePhantomchatPersonaConfig(join(config.personasDir, "ana"), {
    nsec: persona.nsec,
    relays: RELAYS,
    allowedNpubs: [owner.npub],
  });
  app = new FakeApp(owner, () => persona.publicKeyHex);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const base = () => ({ config, env: ENV, makePool: () => app, waitS: 0.3, graceMs: 50 });

describe("protocol", () => {
  test("isLocalToolsRumor needs both tags", () => {
    expect(isLocalToolsRumor({ tags: [[...LOCAL_TOOLS_TAG], [...CONTROL_TAG]] })).toBe(true);
    expect(isLocalToolsRumor({ tags: [[...LOCAL_TOOLS_TAG]] })).toBe(false);
    expect(isLocalToolsRumor({ tags: [[...CONTROL_TAG]] })).toBe(false);
    expect(isLocalToolsRumor({ tags: undefined })).toBe(false);
  });

  test("parseAppMessage validates every field and the type", () => {
    const ok = (b: object) => JSON.stringify({ type: LOCAL_TOOLS_TYPE, ...b });
    expect(parseAppMessage(ok({ t: "capability", deviceId: DEVICE, tools: ["bash", "rm-rf"] }))).toEqual({
      t: "capability",
      deviceId: DEVICE,
      deviceName: "",
      platform: "",
      tools: ["bash"],
    });
    expect(parseAppMessage(ok({ t: "capability", deviceId: "short", tools: [] }))).toBeUndefined();
    expect(parseAppMessage(JSON.stringify({ type: "text", t: "revoked", deviceId: DEVICE }))).toBeUndefined();
    expect(parseAppMessage(ok({ t: "result", callId: "a", seq: 2, total: 2, data: "" }))).toBeUndefined();
    expect(parseAppMessage(ok({ t: "result", callId: "bad id!", seq: 0, total: 1, data: "" }))).toBeUndefined();
    expect(parseAppMessage("not json")).toBeUndefined();
    expect(parseToolResult("{}")).toEqual({ status: "error", output: "malformed result from the device" });
  });

  test("buildCall enforces the protocol limits", () => {
    const now = 1_000_000;
    const c = buildCall({ deviceId: DEVICE, tool: "bash", args: { command: "ls" }, now });
    expect(c.expiresAt - now).toBe(120_000);
    expect(c.callId).toMatch(/^[\w-]{1,64}$/);
    expect(() => buildCall({ deviceId: DEVICE, tool: "rm", args: {} })).toThrow("unknown tool");
    expect(() => buildCall({ deviceId: DEVICE, tool: "bash", args: [] })).toThrow("JSON object");
    expect(() => buildCall({ deviceId: DEVICE, tool: "bash", args: {}, timeoutMs: 600_001 })).toThrow("timeout");
    expect(groupIdForConversation("phantomchat:group:abc")).toBe("abc");
    expect(groupIdForConversation("telegram:1")).toBeUndefined();
  });
});

describe("phantombot device list", () => {
  test("says hello to the principal only, tagged, no self copy, and lists the device", async () => {
    const out = sink();
    expect(await runDeviceList({ ...base(), json: true, out })).toBe(0);
    const devices = JSON.parse(out.text).devices;
    expect(devices).toEqual([
      { device: DEVICE, name: "Desk", platform: "linux", tools: ["bash", "read"], owner: owner.npub },
    ]);
    expect(app.received).toHaveLength(1);
    const hello = app.received[0]!;
    expect(hello.body).toEqual({ type: LOCAL_TOOLS_TYPE, t: "hello" });
    expect(isLocalToolsRumor({ tags: hello.tags })).toBe(true);
    // One wrap per hello: to the app, none to ourselves.
    expect(app.published).toBe(1);
  });

  test("switch OFF = silence = no devices", async () => {
    app.switchOn = false;
    const out = sink();
    expect(await runDeviceList({ ...base(), out })).toBe(0);
    expect(out.text).toContain("no devices online");
  });

  test("ignores a capability from a non-principal and an untagged one", async () => {
    app.switchOn = false;
    const stranger = generateIdentity();
    const cap = { t: "capability", deviceId: DEVICE, deviceName: "Evil", platform: "linux", tools: ["bash"] };
    const realPublish = app.publish.bind(app);
    app.publish = (r, e) => {
      queueMicrotask(() => {
        app.deliver(appWrap(stranger, persona.publicKeyHex, cap));
        app.deliver(appWrap(owner, persona.publicKeyHex, cap, false));
      });
      return realPublish(r, e);
    };
    const out = sink();
    await runDeviceList({ ...base(), json: true, out });
    expect(JSON.parse(out.text).devices).toEqual([]);
  });
});

describe("phantombot device call", () => {
  test("runs on the device by name and joins the chunked result", async () => {
    const out = sink();
    const code = await runDeviceCall({ ...base(), device: "desk", tool: "bash", args: '{"command":"ls"}', out });
    expect(code).toBe(0);
    expect(out.text).toBe('ran {"command":"ls"}\n');
    const call = app.received.find((r) => r.body.t === "call")!.body;
    expect(call.deviceId).toBe(DEVICE);
    expect(call.tool).toBe("bash");
    expect(call.groupId).toBeUndefined();
    expect((call.expiresAt as number) - Date.now()).toBeLessThanOrEqual(600_000);
  });

  test("a group turn's call carries the group id", async () => {
    const env = { ...ENV, PHANTOMBOT_CONVERSATION: "phantomchat:group:g123" };
    await runDeviceCall({ ...base(), env, device: DEVICE, tool: "read", args: '{"path":"/x"}', out: sink() });
    expect(app.received.find((r) => r.body.t === "call")!.body.groupId).toBe("g123");
  });

  test("an offline device is exit 3; a silent device mid-call times out as unavailable", async () => {
    app.switchOn = false;
    const err = sink();
    expect(await runDeviceCall({ ...base(), device: "desk", tool: "bash", args: "{}", err })).toBe(3);
    expect(err.text).toContain("not available");

    app.switchOn = true;
    app.answerCalls = false;
    const err2 = sink();
    const code = await runDeviceCall({
      ...base(),
      device: "desk",
      tool: "bash",
      args: "{}",
      timeoutS: 0.05,
      err: err2,
      out: sink(),
    });
    expect(code).toBe(3);
  });

  test("a result for our call id from another principal's app is ignored", async () => {
    // Allowed, so the principal gate lets it through: only the per-call
    // owner check stands between it and our result.
    const stranger = generateIdentity();
    await savePhantomchatPersonaConfig(join(config.personasDir, "ana"), {
      nsec: persona.nsec,
      relays: RELAYS,
      allowedNpubs: [owner.npub, stranger.npub],
    });
    app.answerCalls = false;
    const realPublish = app.publish.bind(app);
    app.publish = (r, e) => {
      const res = realPublish(r, e);
      queueMicrotask(() => {
        const call = app.received.find((x) => x.body.t === "call")?.body;
        if (!call) return;
        const data = JSON.stringify({ status: "ok", output: "forged" });
        app.deliver(appWrap(stranger, persona.publicKeyHex, { t: "result", callId: call.callId, seq: 0, total: 1, data }));
      });
      return res;
    };
    const out = sink();
    const code = await runDeviceCall({ ...base(), device: "desk", tool: "bash", args: "{}", timeoutS: 0.2, out });
    expect(out.text).not.toContain("forged");
    expect(code).toBe(3);
  });

  test("abort sends cancel for the call", async () => {
    app.answerCalls = false;
    const controller = new AbortController();
    const p = runDeviceCall({ ...base(), device: "desk", tool: "bash", args: "{}", signal: controller.signal, out: sink() });
    while (!app.received.some((r) => r.body.t === "call")) await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    expect(await p).toBe(130);
    await new Promise((r) => setTimeout(r, 10));
    const call = app.received.find((r) => r.body.t === "call")!.body;
    expect(app.received.find((r) => r.body.t === "cancel")?.body.callId).toBe(call.callId);
  });

  test("refuses an untrusted or escorted turn before touching the relays", async () => {
    expect(untrustedReason({ PHANTOMBOT_ESCORT: "1" })).toBeDefined();
    expect(untrustedReason({ PHANTOMBOT_SCRATCH: "/p/scratch/untrusted/x/y" })).toBeDefined();
    expect(untrustedReason({ PHANTOMBOT_SCRATCH: "/p/scratch/trusted/x" })).toBeUndefined();
    const env = { ...ENV, PHANTOMBOT_SCRATCH: "/p/scratch/untrusted/conv/turn" };
    const err = sink();
    expect(await runDeviceCall({ ...base(), env, device: "desk", tool: "bash", args: "{}", err })).toBe(1);
    expect(err.text).toContain("refused");
    expect(app.published).toBe(0);
  });
});
