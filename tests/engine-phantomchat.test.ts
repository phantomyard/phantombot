/**
 * The engine-hosted PhantomChat channel (src/engine/phantomchat.ts), the
 * persona delete and the embeddings setting. Relays are a fake pool that
 * hands real NIP-17 gift-wraps to the real channel + server; harnesses are
 * faked through the engine's test seam.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEngine, type Engine, EngineError, type PhantomchatStatus } from "../src/engine/index.ts";
import { _setChannelPoolForTesting, _setHarnessFactoryForTesting } from "../src/engine/engine.ts";
import type { Harness, HarnessChunk, HarnessRequest } from "../src/harnesses/types.ts";
import { savePhantomchatPersonaConfig } from "../src/channels/phantomchat/personaStore.ts";
import { generateIdentity } from "../src/lib/nostrIdentity.ts";
import {
  isV2Event,
  type NTNostrEvent,
  unwrapNip17Message,
  unwrapV2,
  wrapNip17Message,
} from "../src/lib/nostrCrypto.ts";
import { Database } from "bun:sqlite";

class FakeHarness implements Harness {
  readonly id = "fake";
  requests: HarnessRequest[] = [];
  /** When set, invoke() parks until its signal aborts (an in-flight turn). */
  hang = false;
  started = 0;
  aborted = 0;
  async available(): Promise<boolean> {
    return true;
  }
  async *invoke(req: HarnessRequest): AsyncGenerator<HarnessChunk> {
    this.requests.push(req);
    this.started++;
    if (this.hang) {
      const signal = req.signal;
      await new Promise<void>((resolve) => {
        if (!signal || signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      this.aborted++;
      return;
    }
    yield { type: "text", text: "pong" };
    yield { type: "done", finalText: "pong" };
  }
}

type OnEvent = (event: NTNostrEvent) => void;

/** Relay pool double: records subscriptions and publishes; `deliver` plays a relay. */
class FakePool {
  static all: FakePool[] = [];
  /** When set, the next constructed pool throws (relays unreachable). */
  static failNext = false;
  subscribers: OnEvent[] = [];
  published: NTNostrEvent[] = [];
  closed = false;
  constructor(readonly secretKey: Uint8Array) {
    if (FakePool.failNext) {
      FakePool.failNext = false;
      throw new Error("relays refused");
    }
    FakePool.all.push(this);
  }
  subscribeMany(_relays: string[], filter: { ids?: string[] }, params: { onevent?: OnEvent; oneose?: () => void }) {
    if (filter?.ids) {
      // A read-back of a published event: answer like a relay that stored it.
      queueMicrotask(() => {
        for (const ev of this.published) if (filter.ids!.includes(ev.id)) params?.onevent?.(ev);
        params?.oneose?.();
      });
      return { close() {} };
    }
    if (params?.onevent) this.subscribers.push(params.onevent);
    queueMicrotask(() => params?.oneose?.());
    return { close() {} };
  }
  publish(_relays: string[], event: NTNostrEvent) {
    this.published.push(event);
    return [Promise.resolve("ok")];
  }
  querySync() {
    return Promise.resolve([]);
  }
  close() {
    this.closed = true;
  }
  deliver(event: NTNostrEvent) {
    for (const s of this.subscribers) s(event);
  }
}

let root: string;
let engine: Engine | undefined;
let harness: FakeHarness;
const RELAYS = ["wss://relay.test"];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "phantombot-engine-pc-"));
  harness = new FakeHarness();
  _setHarnessFactoryForTesting(() => [harness]);
  FakePool.all = [];
  FakePool.failNext = false;
  _setChannelPoolForTesting((sk) => new FakePool(sk));
});

afterEach(async () => {
  await engine?.close();
  engine = undefined;
  _setHarnessFactoryForTesting(undefined);
  _setChannelPoolForTesting(undefined);
  rmSync(root, { recursive: true, force: true });
});

async function openEngine(): Promise<Engine> {
  engine = await createEngine({ root, log: "silent" });
  return engine;
}

async function rejectsWith(p: Promise<unknown>, code: string): Promise<EngineError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(EngineError);
    expect((e as EngineError).code).toBe(code as EngineError["code"]);
    return e as EngineError;
  }
  throw new Error(`expected rejection with ${code}`);
}

async function until(cond: () => boolean | Promise<boolean>, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Texts the persona sent to `recipient` (unwrapped from its published wraps). */
async function repliesTo(
  pool: FakePool,
  recipient: { secretKey: Uint8Array; publicKeyHex: string },
): Promise<string[]> {
  const out: string[] = [];
  for (const ev of pool.published) {
    if (ev.kind !== 1059) continue;
    if (!ev.tags.some((t) => t[0] === "p" && t[1] === recipient.publicKeyHex)) continue;
    try {
      const rumor = isV2Event(ev)
        ? await unwrapV2(ev, recipient.secretKey)
        : unwrapNip17Message(ev, recipient.secretKey);
      if (rumor.kind === 14) out.push(rumor.content);
    } catch {
      /* not for us */
    }
  }
  return out;
}

function dm(from: ReturnType<typeof generateIdentity>, toHex: string, text: string): NTNostrEvent {
  return wrapNip17Message(from.secretKey, toHex, text).wraps[0]!;
}

describe("persona.phantomchat allowlist", () => {
  test("info never mints; allow sets up and is idempotent; disallow keeps the last npub", async () => {
    const e = await openEngine();
    const ana = await e.personas.create("ana");
    expect(await ana.phantomchat.info()).toEqual({ npub: null, configured: false, allowedNpubs: [] });
    expect(existsSync(join(root, "data", "phantombot", "personas", "ana", "identity.json"))).toBe(false);

    const owner = generateIdentity();
    const other = generateIdentity();
    const first = await ana.phantomchat.allow(owner.npub, { relays: RELAYS });
    expect(first.added).toBe(true);
    expect(first.npub).toMatch(/^npub1/);
    expect(await ana.phantomchat.allow(owner.npub)).toEqual({ npub: first.npub, added: false, restart: "none" });
    await ana.phantomchat.allow(other.npub);
    expect(await ana.phantomchat.info()).toEqual({
      npub: first.npub,
      configured: true,
      allowedNpubs: [owner.npub, other.npub],
    });

    expect(await ana.phantomchat.disallow(other.npub)).toEqual({ removed: true, restart: "none" });
    expect(await ana.phantomchat.disallow(other.npub)).toEqual({ removed: false, restart: "none" });
    await rejectsWith(ana.phantomchat.disallow(owner.npub), "invalid_argument");
    expect((await ana.phantomchat.info()).allowedNpubs).toEqual([owner.npub]);

    await rejectsWith(ana.phantomchat.allow("npub1nope"), "invalid_argument");
    await rejectsWith(ana.phantomchat.allow(owner.publicKeyHex), "invalid_argument");
    await rejectsWith(ana.phantomchat.allow(owner.npub, { relays: ["https://x"] }), "invalid_argument");
    const file = JSON.parse(
      readFileSync(join(root, "data", "phantombot", "personas", "ana", "phantomchat.json"), "utf8"),
    );
    expect(file.nsec).toBeUndefined();
    expect(file.tofu).toBeUndefined();
    expect(file.relays).toEqual(RELAYS);
  });
});

describe("persona.phantomchat channel", () => {
  test("refuses to start with no allowlist", async () => {
    const e = await openEngine();
    const ana = await e.personas.create("ana");
    await rejectsWith(ana.phantomchat.start(), "not_configured");
    expect(ana.phantomchat.status().state).toBe("failed");
    expect(FakePool.all.length).toBe(0);

    // A file with an EMPTY allowlist (an open or TOFU bot to the daemon) is
    // refused too: an app-hosted persona always has a principal.
    const id = generateIdentity();
    await savePhantomchatPersonaConfig(join(root, "data", "phantombot", "personas", "ana"), {
      nsec: id.nsec,
      relays: RELAYS,
      allowedNpubs: [],
      tofu: true,
    });
    await rejectsWith(ana.phantomchat.start(), "not_configured");
    expect(FakePool.all.length).toBe(0);
  });

  test("answers the principal, ignores a stranger, refuses /restart, and stops", async () => {
    const e = await openEngine();
    const ana = await e.personas.create("ana");
    const owner = generateIdentity();
    const stranger = generateIdentity();
    const { npub } = await ana.phantomchat.allow(owner.npub, { relays: RELAYS });
    const states: PhantomchatStatus["state"][] = [];
    ana.phantomchat.onStatus((s) => states.push(s.state));

    const status = await ana.phantomchat.start({ displayName: "Ana" });
    expect(status).toEqual({ state: "running", npub, relays: 1 });
    // Idempotent while running: no second listener.
    await ana.phantomchat.start();
    expect(FakePool.all.length).toBe(1);
    const pool = FakePool.all[0]!;
    await until(() => pool.subscribers.length > 0);
    const personaHex = (await import("../src/lib/nostrIdentity.ts")).decodeNpubToHex(npub);

    pool.deliver(dm(stranger, personaHex, "hello from a stranger"));
    pool.deliver(dm(owner, personaHex, "ping"));
    await until(async () => (await repliesTo(pool, owner)).includes("pong"));
    expect(harness.requests.map((r) => r.userMessage)).toEqual(["ping"]);
    expect(await repliesTo(pool, stranger)).toEqual([]);

    pool.deliver(dm(owner, personaHex, "/restart"));
    await until(async () => (await repliesTo(pool, owner)).some((t) => t.includes("isn't available")));
    expect((await repliesTo(pool, owner)).some((t) => t.includes("restarting"))).toBe(false);

    await ana.phantomchat.stop();
    expect(ana.phantomchat.status().state).toBe("stopped");
    expect(pool.closed).toBe(true);
    expect(states).toEqual(["starting", "running", "stopped"]);
  });

  test("allow while running restarts the channel so the new npub is answered", async () => {
    const e = await openEngine();
    const ana = await e.personas.create("ana");
    const owner = generateIdentity();
    const second = generateIdentity();
    const { npub } = await ana.phantomchat.allow(owner.npub, { relays: RELAYS });
    await ana.phantomchat.start();
    expect(await ana.phantomchat.allow(second.npub)).toMatchObject({ added: true, restart: "restarted" });
    expect(FakePool.all.length).toBe(2);
    expect(FakePool.all[0]!.closed).toBe(true);
    expect(ana.phantomchat.status().state).toBe("running");
    const pool = FakePool.all[1]!;
    await until(() => pool.subscribers.length > 0);
    const personaHex = (await import("../src/lib/nostrIdentity.ts")).decodeNpubToHex(npub);
    pool.deliver(dm(second, personaHex, "hi"));
    await until(async () => (await repliesTo(pool, second)).includes("pong"));
  });

  test("a failed restart after allow/disallow resolves as restart 'failed', the change kept", async () => {
    const e = await openEngine();
    const ana = await e.personas.create("ana");
    const owner = generateIdentity();
    const second = generateIdentity();
    await ana.phantomchat.allow(owner.npub, { relays: RELAYS });
    await ana.phantomchat.start();

    FakePool.failNext = true;
    const r = await ana.phantomchat.allow(second.npub);
    expect(r).toMatchObject({ added: true, restart: "failed" });
    expect(r.error).toContain("relays refused");
    expect(ana.phantomchat.status().state).toBe("failed");
    expect((await ana.phantomchat.info()).allowedNpubs).toEqual([owner.npub, second.npub]);

    // A stopped (failed) channel needs no restart; start() brings it back.
    expect(await ana.phantomchat.disallow(second.npub)).toEqual({ removed: true, restart: "none" });
    expect((await ana.phantomchat.start()).state).toBe("running");
    await ana.phantomchat.allow(second.npub);
    FakePool.failNext = true;
    const d = await ana.phantomchat.disallow(second.npub);
    expect(d).toMatchObject({ removed: true, restart: "failed" });
    expect((await ana.phantomchat.info()).allowedNpubs).toEqual([owner.npub]);
  });

  test("embedded /model: show and list answer, set and clear are refused", async () => {
    const e = await openEngine();
    const ana = await e.personas.create("ana");
    const owner = generateIdentity();
    const { npub } = await ana.phantomchat.allow(owner.npub, { relays: RELAYS });
    await ana.phantomchat.start();
    const pool = FakePool.all[0]!;
    await until(() => pool.subscribers.length > 0);
    const personaHex = (await import("../src/lib/nostrIdentity.ts")).decodeNpubToHex(npub);
    const refused = (t: string) => t.includes("isn't available");

    pool.deliver(dm(owner, personaHex, "/model"));
    await until(async () => (await repliesTo(pool, owner)).length >= 1);
    expect(refused((await repliesTo(pool, owner))[0]!)).toBe(false);

    pool.deliver(dm(owner, personaHex, "/model some/other-model"));
    await until(async () => (await repliesTo(pool, owner)).length >= 2);
    const second = (await repliesTo(pool, owner))[1]!;
    expect(refused(second)).toBe(true);
    expect(second.includes("restarting")).toBe(false);

    pool.deliver(dm(owner, personaHex, "/model clear"));
    await until(async () => (await repliesTo(pool, owner)).length >= 3);
    expect(refused((await repliesTo(pool, owner))[2]!)).toBe(true);
  });

  test("configure() restarts a running channel so it runs with the new settings", async () => {
    const e = await openEngine();
    const ana = await e.personas.create("ana");
    await ana.phantomchat.allow(generateIdentity().npub, { relays: RELAYS });
    await ana.phantomchat.start();
    await ana.configure({ embeddings: { provider: "none" } });
    expect(FakePool.all.length).toBe(2);
    expect(FakePool.all[0]!.closed).toBe(true);
    expect(ana.phantomchat.status().state).toBe("running");
  });

  test("Local PC tools control rumors never become a turn, even with a plain-text body", async () => {
    const e = await openEngine();
    const ana = await e.personas.create("ana");
    const owner = generateIdentity();
    const { npub } = await ana.phantomchat.allow(owner.npub, { relays: RELAYS });
    await ana.phantomchat.start();
    const pool = FakePool.all[0]!;
    await until(() => pool.subscribers.length > 0);
    const personaHex = (await import("../src/lib/nostrIdentity.ts")).decodeNpubToHex(npub);
    const { createGiftWrap, createRumor, createSeal } = await import("../src/lib/nostrCrypto.ts");
    const { LOCAL_TOOLS_TAG, CONTROL_TAG } = await import("../src/channels/phantomchat/localTools.ts");
    const tagged = (content: string) => {
      const rumor = createRumor(content, owner.secretKey, [["p", personaHex], [...LOCAL_TOOLS_TAG], [...CONTROL_TAG]]);
      return createGiftWrap(createSeal(rumor, owner.secretKey, personaHex), personaHex) as unknown as NTNostrEvent;
    };
    pool.deliver(tagged("please run this as a turn"));
    pool.deliver(tagged(JSON.stringify({ type: "phantomchat-local-tools", t: "capability" })));
    pool.deliver(dm(owner, personaHex, "ping"));
    await until(async () => (await repliesTo(pool, owner)).includes("pong"));
    expect(harness.requests.map((r) => r.userMessage)).toEqual(["ping"]);
  });

  test("engine.close() stops a running channel", async () => {
    const e = await openEngine();
    const ana = await e.personas.create("ana");
    await ana.phantomchat.allow(generateIdentity().npub, { relays: RELAYS });
    await ana.phantomchat.start();
    await e.close();
    expect(FakePool.all[0]!.closed).toBe(true);
    expect(ana.phantomchat.status().state).toBe("stopped");
  });
});

describe("personas.delete", () => {
  test("stops the channel and removes the directory, index and every memory row", async () => {
    const e = await openEngine();
    const ana = await e.personas.create("ana");
    const bob = await e.personas.create("bob");
    await ana.phantomchat.allow(generateIdentity().npub, { relays: RELAYS });
    await ana.phantomchat.start();
    await ana.ask({ message: "remember this", source: "principal", conversation: "c1" });
    await bob.ask({ message: "keep me", source: "principal", conversation: "c1" });
    await ana.memory.capture("a note", { tags: ["decision"] });

    expect(await e.personas.delete("ana")).toBe(true);
    expect(FakePool.all[0]!.closed).toBe(true);
    expect(existsSync(join(root, "data", "phantombot", "personas", "ana"))).toBe(false);
    expect(await e.personas.exists("ana")).toBe(false);
    expect(await e.personas.delete("ana")).toBe(false);
    await rejectsWith(e.personas.delete("../bob"), "invalid_argument");
    // The tombstone the delete renames the dir into is gone too.
    expect(readdirSync(join(root, "data", "phantombot", ".deleted-personas"))).toEqual([]);

    await e.close();
    engine = undefined;
    const db = new Database(join(root, "data", "phantombot", "memory.sqlite"), { readonly: true });
    try {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
        (r) => r.name,
      );
      let anaRows = 0;
      for (const t of tables) {
        const cols = db.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[];
        if (!cols.some((c) => c.name === "persona")) continue;
        anaRows += (db.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE persona = 'ana'`).get() as { n: number }).n;
      }
      expect(anaRows).toBe(0);
      const bobTurns = db.prepare("SELECT COUNT(*) AS n FROM turns WHERE persona = 'bob'").get() as { n: number };
      expect(bobTurns.n).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
  // Windows refuses to remove a file something still holds open; a recursive
  // rm then dies half way, after identity.json is already gone. The
  // delete must be all-or-nothing: an unremovable dir leaves the persona whole.
  test.skipIf(process.getuid?.() === 0)("a dir that cannot be moved leaves the persona whole and retryable", async () => {
    const e = await openEngine();
    const ana = await e.personas.create("ana");
    await ana.ask({ message: "remember this", source: "principal", conversation: "c1" });
    const personas = join(root, "data", "phantombot", "personas");
    const files = readdirSync(join(personas, "ana")).sort();
    chmodSync(personas, 0o555);
    try {
      await rejectsWith(e.personas.delete("ana"), "write_failed");
    } finally {
      chmodSync(personas, 0o755);
    }
    expect(readdirSync(join(personas, "ana")).sort()).toEqual(files);
    expect(await e.personas.exists("ana")).toBe(true);
    const db = new Database(join(root, "data", "phantombot", "memory.sqlite"), { readonly: true });
    try {
      const n = (db.prepare("SELECT COUNT(*) AS n FROM turns WHERE persona = 'ana'").get() as { n: number }).n;
      expect(n).toBeGreaterThan(0);
    } finally {
      db.close();
    }
    expect(await e.personas.delete("ana")).toBe(true);
    expect(existsSync(join(personas, "ana"))).toBe(false);
  });

  test("cancels and awaits the persona's in-flight turn first; other personas' turns run on", async () => {
    const e = await openEngine();
    const ana = await e.personas.create("ana");
    const bob = await e.personas.create("bob");
    harness.hang = true;
    const anaTurn = ana.ask({ message: "long job", source: "principal", conversation: "c1" }).catch((x) => x);
    await until(() => harness.started === 1);
    const bobTurn = bob.ask({ message: "bob job", source: "principal", conversation: "c2" }).catch((x) => x);
    await until(() => harness.started === 2);

    expect(await e.personas.delete("ana")).toBe(true);
    // ana's turn was aborted and unwound before the delete resolved; bob's was not touched.
    expect(harness.aborted).toBe(1);
    await anaTurn;
    expect(existsSync(join(root, "data", "phantombot", "personas", "ana"))).toBe(false);

    harness.hang = false;
    const late = await ana.ask({ message: "after", source: "principal", conversation: "c1" }).catch((x) => x);
    expect(late).toBeInstanceOf(EngineError);
    expect((late as EngineError).code).toBe("persona_not_found");
    await e.close();
    engine = undefined;
    expect(harness.aborted).toBe(2);
    await bobTurn;
  });

  // Issue #771: a delete used to remove only the persona dir, leaving
  // state.json's default_persona naming a persona that no longer existed and
  // that persona's native agent dir (auth.json + model config) on disk.

  const statePath = () => join(root, "data", "phantombot", "state.json");
  const nativeAgent = (name: string) => join(root, "data", "pi-native", "personas", name, "agent");
  const seedCredential = (name: string) => {
    mkdirSync(nativeAgent(name), { recursive: true });
    writeFileSync(join(nativeAgent(name), "auth.json"), JSON.stringify({ openai: { type: "api_key", key: `sk-${name}` } }));
  };

  test("re-points the host default (audited) and removes only that persona's native agent dir", async () => {
    const e = await openEngine();
    await e.personas.create("ana");
    await e.personas.create("bob");
    // state.json is written by the persona-producing paths OUTSIDE the engine
    // (adoptAsDefaultIfMissing), so seed it the way they leave it.
    writeFileSync(statePath(), JSON.stringify({ default_persona: "bob" }));
    seedCredential("ana");
    seedCredential("bob");
    // The host-level legacy dir is every SURVIVING persona's migration source.
    const legacy = join(root, "data", "pi-native", "agent", "auth.json");
    mkdirSync(join(root, "data", "pi-native", "agent"), { recursive: true });
    writeFileSync(legacy, '{"openai":{"type":"api_key","key":"sk-legacy"}}');

    expect(await e.personas.delete("bob")).toBe(true);

    // The default moved to the one survivor, not to a ghost.
    expect(JSON.parse(readFileSync(statePath(), "utf8")).default_persona).toBe("ana");
    // Only bob's native scope went; ana's and the legacy dir are byte-identical.
    expect(existsSync(join(root, "data", "pi-native", "personas", "bob"))).toBe(false);
    expect(readFileSync(join(nativeAgent("ana"), "auth.json"), "utf8")).toBe('{"openai":{"type":"api_key","key":"sk-ana"}}');
    expect(readFileSync(legacy, "utf8")).toBe('{"openai":{"type":"api_key","key":"sk-legacy"}}');
    // It went through saveState, so the change is auditable like any other.
    expect(readFileSync(join(root, "data", "phantombot", "state-audit.log"), "utf8")).toContain(
      '"from":"bob","to":"ana"',
    );

    // A persona re-created under the same name starts clean.
    await e.personas.create("bob");
    expect(existsSync(join(nativeAgent("bob"), "auth.json"))).toBe(false);
    await e.close();
    engine = undefined;
  });

  test("deleting the last persona clears the default and leaves no native persona dirs", async () => {
    const e = await openEngine();
    await e.personas.create("ana");
    writeFileSync(statePath(), JSON.stringify({ default_persona: "ana" }));
    seedCredential("ana");

    expect(await e.personas.delete("ana")).toBe(true);

    expect(JSON.parse(readFileSync(statePath(), "utf8")).default_persona ?? null).toBeNull();
    const natives = join(root, "data", "pi-native", "personas");
    expect(existsSync(natives) ? readdirSync(natives) : []).toEqual([]);
    await e.close();
    engine = undefined;
  });

  test("a non-default delete leaves the default alone and drops its autostart roster entries", async () => {
    const e = await openEngine();
    await e.personas.create("ana");
    await e.personas.create("bob");
    writeFileSync(statePath(), JSON.stringify({ default_persona: "ana" }));
    mkdirSync(join(root, "config", "phantombot"), { recursive: true });
    writeFileSync(
      join(root, "config", "phantombot", "config.toml"),
      'autostart_personas = ["ana", "bob"]\n\n[autostart_modes]\nbob = "boot"\nana = "login"\n',
    );

    expect(await e.personas.delete("bob")).toBe(true);

    expect(JSON.parse(readFileSync(statePath(), "utf8")).default_persona).toBe("ana");
    const toml = readFileSync(join(root, "config", "phantombot", "config.toml"), "utf8");
    expect(toml).toContain('autostart_personas = [ "ana" ]');
    expect(toml).toContain('ana = "login"');
    expect(toml).not.toContain('bob = "boot"');
    await e.close();
    engine = undefined;
  });
});

describe("configure({ embeddings })", () => {
  const tomlOf = () =>
    readFileSync(join(root, "data", "phantombot", "personas", "ana", "config.toml"), "utf8");

  test("gemini keeps the key in the vault; openai-compatible without a key removes it", async () => {
    const e = await openEngine();
    const ana = await e.personas.create("ana");
    await ana.configure({ embeddings: { provider: "gemini", apiKey: "gk-test-1" } });
    expect(tomlOf()).toContain('provider = "gemini"');
    expect(tomlOf()).toContain('model = "gemini-embedding-001"');
    expect(tomlOf()).not.toContain("gk-test");
    expect(await ana.secrets.has("PHANTOMBOT_GEMINI_API_KEY")).toBe(true);

    await ana.configure({
      embeddings: { provider: "openai-compatible", baseUrl: "http://127.0.0.1:9/v1", model: "e5", apiKey: "ok-test-1" },
    });
    expect(await ana.secrets.has("PHANTOMBOT_OPENAI_COMPATIBLE_API_KEY")).toBe(true);
    await ana.configure({
      embeddings: { provider: "openai-compatible", baseUrl: "http://127.0.0.1:10/v1", model: "e5" },
    });
    expect(await ana.secrets.has("PHANTOMBOT_OPENAI_COMPATIBLE_API_KEY")).toBe(false);
    expect(tomlOf()).toContain('base_url = "http://127.0.0.1:10/v1"');
    expect(tomlOf()).not.toContain("ok-test");

    await ana.configure({ embeddings: { provider: "none" } });
    expect(tomlOf()).toContain('provider = "none"');
  });

  test("rejects bad embeddings settings without writing", async () => {
    const e = await openEngine();
    const ana = await e.personas.create("ana");
    const bad: unknown[] = [
      { provider: "gemini", apiKey: "" },
      { provider: "gemini", apiKey: "k", dims: 0 },
      { provider: "openai-compatible", baseUrl: "ftp://x", model: "m" },
      { provider: "openai-compatible", baseUrl: "http://x", model: " " },
      { provider: "openai-compatible", baseUrl: "http://x", model: "m", dims: -1 },
      { provider: "openai-compatible", baseUrl: "http://x", model: "m", apiKey: "" },
      { provider: "voyage" },
    ];
    for (const embeddings of bad) {
      await rejectsWith(ana.configure({ embeddings } as never), "invalid_argument");
    }
    expect(existsSync(join(root, "data", "phantombot", "personas", "ana", "config.toml"))
      ? tomlOf().includes("[embeddings")
      : false).toBe(false);
  });
});
