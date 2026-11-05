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
import { withPersonaEnv } from "../src/lib/envBootstrap.ts";
import type { Config } from "../src/config.ts";
import {
  buildCall,
  CONTROL_TAG,
  groupIdForConversation,
  isLocalToolsRumor,
  LOCAL_TOOLS_TAG,
  LOCAL_TOOLS_TYPE,
  LocalToolsClient,
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
function appWrap(from: Id, toHex: string, body: Record<string, unknown>, tags = true, skewMs = 0): NTNostrEvent {
  // skewMs stamps the rumor with the DEVICE's (skewed) clock, as the app does.
  const realNow = Date.now;
  if (skewMs) Date.now = () => realNow() + skewMs;
  let rumor: ReturnType<typeof createRumor>;
  try {
    rumor = createRumor(JSON.stringify({ type: LOCAL_TOOLS_TYPE, ...body }), from.secretKey, [
    ["p", toHex],
    ...(tags ? [[...LOCAL_TOOLS_TAG], [...CONTROL_TAG]] : []),
  ]);
  } finally {
    Date.now = realNow;
  }
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
  closedRelays: Array<string[] | undefined> = [];
  switchOn = true;
  /** The device's clock offset from ours, in ms (negative = behind). */
  skewMs = 0;
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
  close(relays?: string[]) {
    this.closedRelays.push(relays);
  }
  deliver(e: NTNostrEvent) {
    for (const s of this.subscribers) s(e);
  }
  #read(event: NTNostrEvent) {
    const rumor = unwrapNip17Message(event, this.identity.secretKey);
    const body = JSON.parse(rumor.content) as Record<string, unknown>;
    this.received.push({ to: event.tags[0]![1]!, tags: rumor.tags, body });
    if (!this.switchOn) return;
    const reply = (b: Record<string, unknown>) =>
      this.deliver(appWrap(this.identity, this.personaHex(), b, true, this.skewMs));
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
    expect(app.closedRelays).toEqual([RELAYS]);
  });

  test("switch OFF = silence = no devices", async () => {
    app.switchOn = false;
    const out = sink();
    expect(await runDeviceList({ ...base(), out })).toBe(0);
    expect(out.text).toContain("no devices online");
    expect(app.closedRelays).toEqual([RELAYS]);
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

describe("device relay ownership", () => {
  for (const command of ["list", "call"] as const) {
    test(`${command} closes its pool when discovery fails`, async () => {
      app.publish = () => [Promise.reject(new Error("relay offline"))];
      const input = { ...base(), out: sink(), err: sink() };
      const run = command === "list"
        ? runDeviceList(input)
        : runDeviceCall({ ...input, device: "desk", tool: "bash", args: "{}" });
      await expect(run).rejects.toThrow("no relay accepted");
      expect(app.closedRelays).toEqual([RELAYS]);
    });
  }

  test("closing a protocol client leaves its caller-owned pool open", () => {
    const client = new LocalToolsClient({
      secretKey: persona.secretKey,
      publicKeyHex: persona.publicKeyHex,
      principalsHex: [owner.publicKeyHex],
      relays: RELAYS,
      pool: app,
    });
    client.open();
    client.close();
    expect(app.closedRelays).toEqual([]);
  });
});

describe("phantombot device call", () => {
  test("runs on the device by name and joins the chunked result", async () => {
    const out = sink();
    const code = await runDeviceCall({ ...base(), device: "desk", tool: "bash", args: '{"command":"ls"}', out });
    expect(code).toBe(0);
    expect(app.closedRelays).toEqual([RELAYS]);
    expect(out.text).toBe('ran {"command":"ls"}\n');
    const call = app.received.find((r) => r.body.t === "call")!.body;
    expect(call.deviceId).toBe(DEVICE);
    expect(call.tool).toBe("bash");
    expect(call.groupId).toBeUndefined();
    expect((call.expiresAt as number) - Date.now()).toBeLessThanOrEqual(600_000);
  });

  test("a group turn's call carries the group id", async () => {
    const env = { ...ENV, PHANTOMBOT_CONVERSATION: "phantomchat:group:g123", PHANTOMBOT_TRUSTED: "1" };
    await runDeviceCall({ ...base(), env, device: DEVICE, tool: "read", args: '{"path":"/x"}', out: sink() });
    expect(app.received.find((r) => r.body.t === "call")!.body.groupId).toBe("g123");
  });

  test("an offline device is exit 3; a silent device mid-call times out as unavailable", async () => {
    app.switchOn = false;
    const err = sink();
    expect(await runDeviceCall({ ...base(), device: "desk", tool: "bash", args: "{}", err })).toBe(3);
    expect(err.text).toContain("not available");
    expect(app.closedRelays).toEqual([RELAYS]);

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
    expect(app.closedRelays).toEqual([RELAYS, RELAYS]);
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
    expect(app.closedRelays).toEqual([RELAYS]);
    await new Promise((r) => setTimeout(r, 10));
    const call = app.received.find((r) => r.body.t === "call")!.body;
    expect(app.received.find((r) => r.body.t === "cancel")?.body.callId).toBe(call.callId);
  });

  test("inside a turn, refuses unless the runtime marked the turn trusted", async () => {
    // Plain human shell: no turn context, allowed.
    expect(untrustedReason({})).toBeUndefined();
    // A harness turn with NO evidence either way (e.g. scratch provisioning
    // failed, not escorted) must fail CLOSED.
    expect(untrustedReason({ PHANTOMBOT_TURN_ID: "t-1", PHANTOMBOT_PERSONA: "ana" })).toBeDefined();
    expect(untrustedReason({ PHANTOMBOT_CONVERSATION: "telegram:1" })).toBeDefined();
    expect(untrustedReason({ PHANTOMBOT_TURN_ID: "t-1", PHANTOMBOT_TRUSTED: "0" })).toBeDefined();
    expect(untrustedReason({ PHANTOMBOT_TURN_ID: "t-1", PHANTOMBOT_TRUSTED: "1" })).toBeUndefined();
    expect(untrustedReason({ PHANTOMBOT_TURN_ID: "t-1", PHANTOMBOT_TRUSTED: "1", PHANTOMBOT_ESCORT: "1" })).toBeDefined();
    const env = { ...ENV, PHANTOMBOT_TURN_ID: "t-1" };
    const err = sink();
    expect(await runDeviceCall({ ...base(), env, device: "desk", tool: "bash", args: "{}", err })).toBe(1);
    expect(err.text).toContain("refused");
    expect(app.published).toBe(0);
  });

  test("withPersonaEnv sets the trusted marker only for trusted turns and clears an inherited one", () => {
    const inherited = { PHANTOMBOT_TRUSTED: "1", PATH: "/bin" } as NodeJS.ProcessEnv;
    expect(withPersonaEnv(inherited, "ana", "c", "t", undefined, true).PHANTOMBOT_TRUSTED).toBe("1");
    expect(withPersonaEnv(inherited, "ana", "c", "t", undefined, false).PHANTOMBOT_TRUSTED).toBeUndefined();
    expect(withPersonaEnv(inherited, "ana", "c", "t").PHANTOMBOT_TRUSTED).toBeUndefined();
    // A trusted turn's env passes the gate; an untrusted one does not.
    expect(untrustedReason(withPersonaEnv({}, "ana", "c", "t", undefined, true))).toBeUndefined();
    expect(untrustedReason(withPersonaEnv(inherited, "ana", "c", "t", undefined, false))).toBeDefined();
  });

});

describe("device clock skew", () => {
  test("a PC 60s behind our clock is listed and its results arrive", async () => {
    app.skewMs = -60_000;
    const out = sink();
    expect(await runDeviceList({ ...base(), json: true, out })).toBe(0);
    expect(JSON.parse(out.text).devices).toHaveLength(1);
    const callOut = sink();
    expect(
      await runDeviceCall({ ...base(), device: "desk", tool: "bash", args: '{"command":"ls"}', out: callOut }),
    ).toBe(0);
    expect(callOut.text).toContain("ran");
  });

  test("ignores a session older than the window, and an older capability can't undo a newer revoke", async () => {
    let onevent: OnEvent = () => {};
    const pool = {
      subscribeMany: (_r: string[], _f: unknown, p: { onevent?: OnEvent }) => {
        if (p.onevent) onevent = p.onevent;
        return { close() {} };
      },
      publish: () => [Promise.resolve("ok")],
      close() {},
    };
    const client = new LocalToolsClient({
      secretKey: persona.secretKey,
      publicKeyHex: persona.publicKeyHex,
      relays: RELAYS,
      principalsHex: [owner.publicKeyHex],
      pool: pool as never,
    });
    client.open();
    const feed = async (body: Record<string, unknown>, skewMs: number) => {
      onevent(appWrap(owner, persona.publicKeyHex, body, true, skewMs));
      await new Promise((r) => setTimeout(r, 5));
    };
    const cap = { t: "capability", deviceId: DEVICE, deviceName: "Desk", platform: "linux", tools: ["bash"] };
    await feed(cap, -10 * 60_000); // an older session, outside the window
    expect(client.devices.size).toBe(0);
    await feed({ t: "revoked", deviceId: DEVICE }, -30_000);
    await feed(cap, -90_000); // older than the revoke, delivered after it
    expect(client.devices.size).toBe(0);
    await feed(cap, -10_000); // genuinely newer
    expect(client.devices.size).toBe(1);
    client.close();
  });

});
