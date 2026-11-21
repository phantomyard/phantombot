import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSessions, CHROME_START_FAILED, FOCUS_SCRIPT, SNAPSHOT_SCRIPT, type BrowserView, type WebViewRuntime, validateRequest } from "../src/browser/session.ts";
import { browserCall, browserChildEnv, runBrowserDaemon } from "../src/browser/daemon.ts";
import { acquireRunLock } from "../src/lib/runLock.ts";
import { browserRoot, runBrowser } from "../src/cli/browser.ts";
import type { Config } from "../src/config.ts";
import browserCommand from "../src/cli/browser.ts";
import { parseArgs, type ArgsDef } from "citty";
import { sessionToolResult } from "../src/security/extension.ts";
import { handleSecurityMcp } from "../src/security/mcpServer.ts";

const roots: string[] = [];
afterEach(async () => { for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }); });
async function temp() { const p = await mkdtemp(join(tmpdir(), "pb-browser-")); roots.push(p); return p; }

function fakeRuntime() {
  const calls: unknown[][] = [];
  const options: unknown[] = [];
  class View implements BrowserView {
    url = ""; title = "Fixture";
    constructor(value: unknown) { options.push(value); }
    async navigate(url: string) { this.url = url; calls.push(["navigate", url]); }
    async evaluate(script: string): Promise<unknown> { calls.push(["evaluate", script]); return script === "navigator.userAgent" ? "HeadlessChrome/156.0.0.0" : { text: "fixture" }; }
    async cdp(method: string, params?: unknown) { calls.push([method, params]); if (method === "Browser.close") throw new Error("Chrome closed"); return {}; }
    async screenshot() { return Buffer.from("\x89PNG\r\n\x1a\n"); }
    async click(selector: string | number, y?: number | { timeout: number }) { calls.push(typeof selector === "number" ? ["clickAt", selector, y] : ["click", selector]); }
    async scrollTo(selector: string) { calls.push(["scrollTo", selector]); }
    async type(text: string) { calls.push(["type", text]); }
    async press(key: string) { calls.push(["press", key]); }
    async scroll(dx: number, dy: number) { calls.push(["scroll", dx, dy]); }
    async resize(w: number, h: number) { calls.push(["resize", w, h]); }
    close() { calls.push(["close"]); }
    static closeAll() { calls.push(["closeAll"]); }
  }
  return { runtime: View as unknown as WebViewRuntime, calls, options };
}

describe("browser sessions", () => {
  test("sets Chrome UA before site navigation, reuses tabs, and never attaches to personal Chrome", async () => {
    const root = await temp(); const fake = fakeRuntime(); const sessions = new BrowserSessions(root, fake.runtime);
    await sessions.execute({ action: "open", url: "https://example.com" });
    await sessions.execute({ action: "read" });
    expect(fake.options).toEqual([{ backend: { type: "chrome", url: false, stderr: "inherit", argv: process.platform === "darwin" ? ["--use-mock-keychain"] : [] }, dataStore: { directory: join(root, "profile") }, width: 1280, height: 800 }]);
    const override = fake.calls.findIndex(c => c[0] === "Emulation.setUserAgentOverride");
    expect(override).toBeGreaterThan(0);
    expect(fake.calls[override]?.[1]).toMatchObject({ userAgent: "Chrome/156.0.0.0" });
    expect(override).toBeLessThan(fake.calls.findIndex(c => c[0] === "navigate" && c[1] === "https://example.com"));
    const downloadPolicy = fake.calls.findIndex(c => c[0] === "Page.setDownloadBehavior");
    expect(downloadPolicy).toBeGreaterThan(0);
    expect(fake.calls[downloadPolicy]?.[1]).toEqual({ behavior: "deny" });
    expect(downloadPolicy).toBeLessThan(fake.calls.findIndex(c => c[0] === "navigate" && c[1] === "https://example.com"));
    await sessions.execute({ action: "click", selector: "button" });
    expect(fake.calls.findIndex(c => c[0] === "scrollTo")).toBeLessThan(fake.calls.findIndex(c => c[0] === "click"));
    sessions.closeAll();
  });

  test("custom UA persists per tab, suppresses hints, resets from original identity and clears on close", async () => {
    const fake = fakeRuntime(); const sessions = new BrowserSessions(await temp(), fake.runtime);
    const open = (session: string, extra = {}) => sessions.execute({ action: "open", url: "https://example.com", session, ...extra });
    const last = () => fake.calls.filter(c => c[0] === "Emulation.setUserAgentOverride").at(-1)![1];
    await open("custom", { userAgent: "MyBrowser/1.0" });
    expect(last()).toEqual({ userAgent: "MyBrowser/1.0" });
    await open("custom"); expect(last()).toEqual({ userAgent: "MyBrowser/1.0" });
    await open("other"); expect(last()).toMatchObject({ userAgent: "Chrome/156.0.0.0", userAgentMetadata: { text: "fixture" } });
    await open("custom", { userAgent: null }); expect(last()).toMatchObject({ userAgent: "Chrome/156.0.0.0", userAgentMetadata: { text: "fixture" } });
    // Baseline must be captured only once per view, before any custom override.
    expect(fake.calls.filter(c => c[0] === "evaluate" && c[1] === "navigator.userAgent")).toHaveLength(2);
    await open("custom", { userAgent: "Other/2.0" });
    await sessions.execute({ action: "close", session: "custom" });
    await open("custom"); expect(last()).toMatchObject({ userAgent: "Chrome/156.0.0.0" });
    sessions.closeAll();
  });

  test("tab close does not discard another tab, stop cleans the browser, and screenshot returns a file", async () => {
    const root = await temp(); const fake = fakeRuntime(); const sessions = new BrowserSessions(root, fake.runtime);
    for (const session of ["a", "b"]) await sessions.execute({ action: "open", url: "https://example.com", session });
    await sessions.execute({ action: "close", session: "a" });
    await expect(sessions.execute({ action: "read", session: "a" })).rejects.toThrow("not open");
    const shot = await sessions.execute({ action: "screenshot", session: "b" }) as { path: string };
    expect(shot.path.startsWith(join(root, "screenshots"))).toBe(true);
    expect((await readFile(shot.path)).length).toBeGreaterThan(0);
    await sessions.execute({ action: "stop" });
    expect(fake.calls.some(c => c[0] === "Browser.close")).toBe(true);
    expect(fake.calls.at(-1)).toEqual(["closeAll"]);
  });

  test("navigation deadline closes a hung view and allows the next open", async () => {
    const root = await temp(); const fake = fakeRuntime();
    const Original = fake.runtime;
    class Hung extends Original { override async navigate(): Promise<unknown> { return new Promise(() => {}); } }
    const sessions = new BrowserSessions(root, Hung, 20);
    await expect(sessions.execute({ action: "open", url: "https://example.com" })).rejects.toThrow("timed out");
    expect(fake.calls.some(c => c[0] === "close")).toBe(true);
    expect(fake.calls.some(c => c[0] === "closeAll")).toBe(true);
    await expect(sessions.execute({ action: "read" })).rejects.toThrow("not open");
    sessions.closeAll();
  });
});

test("rejects unsafe URLs, malformed input and unbounded dimensions", () => {
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "https://u:secret@example.com"]) expect(() => validateRequest({ action: "open", url })).toThrow();
  for (const userAgent of ["", "   ", "a\nb", "a\rb", "a\tb", "é", "a".repeat(513), 42, {}, false]) expect(() => validateRequest({ action: "open", url: "https://example.com", userAgent })).toThrow();
  expect(() => validateRequest({ action: "read", userAgent: "Custom/1" })).toThrow();
  for (const value of [null, [], { action: "nope" }, { action: "open" }, { action: "read", session: "../a" }, { action: "scroll", dy: NaN }, { action: "resize", width: 1e8, height: 800 }]) expect(() => validateRequest(value)).toThrow();
});

test("Citty accepts actions with no positional value", async () => {
  const args = typeof browserCommand.args === "function" ? await browserCommand.args() : browserCommand.args;
  expect(parseArgs(["open", "https://example.com", "--user-agent", "Custom/1"], args as ArgsDef)["user-agent"]).toBe("Custom/1");
  expect(parseArgs(["open", "https://example.com", "--user-agent", ""], args as ArgsDef)["user-agent"]).toBe("");
  for (const action of ["read", "screenshot", "close", "stop", "scroll"]) {
    expect(parseArgs([action], args as ArgsDef).action).toBe(action);
  }
});

test("native and MCP broker replies preserve images without duplicating base64 as text", async () => {
  const data = Buffer.from("fixture-image").toString("base64");
  const response = { ok: true, text: JSON.stringify({ result: { path: "/scratch/shot.png" }, image: { data, mimeType: "image/png" } }) };
  const native = sessionToolResult(response);
  expect(native.content).toEqual([{ type: "text", text: JSON.stringify({ result: { path: "/scratch/shot.png" } }) }, { type: "image", data, mimeType: "image/png" }]);
  const mcp = await handleSecurityMcp({ id: 1, method: "tools/call", params: { name: "broker", arguments: { operation: { kind: "browser", request: { action: "screenshot" } } } } }, { url: "http://127.0.0.1:1/operation", token: "a".repeat(64), workspace: "/scratch" }, async () => response) as { result: { content: unknown } };
  expect(mcp.result.content).toEqual(native.content);
});

test("worker inherits OS paths but never vault keys or personal remote-debugging configuration", () => {
  expect(browserChildEnv({ HOME: "/fixture", PATH: "/bin", BUN_CHROME_PATH: "/chrome", GITHUB_TOKEN: "never", PHANTOMBOT_PERSONA: "other", OPENAI_API_KEY: "never" })).toEqual({ HOME: "/fixture", PATH: "/bin", BUN_CHROME_PATH: "/chrome" });
});

test("persona and trust scopes cannot share browser cookies", async () => {
  const root = await temp();
  await mkdir(join(root, "alice")); await mkdir(join(root, "bob"));
  const config = { personasDir: root, defaultPersona: "bob" } as Config;
  expect(await browserRoot(undefined, config, { PHANTOMBOT_PERSONA: "alice" })).toBe(join(root, "alice", "browser"));
  expect(await browserRoot("bob", config, { PHANTOMBOT_PERSONA: "alice" })).toBe(join(root, "bob", "browser"));
  const untrusted = { PHANTOMBOT_TURN_ID: "1", PHANTOMBOT_PERSONA: "alice", PHANTOMBOT_SCRATCH: join(root, "scratch") };
  await expect(browserRoot(undefined, config, untrusted)).rejects.toThrow("runtime broker");
  await expect(browserRoot("bob", config, untrusted)).rejects.toThrow("runtime broker");
  await expect(browserRoot(undefined, config, { PHANTOMBOT_TURN_ID: "1" })).rejects.toThrow("runtime broker");
  await expect(browserRoot("../escape", config, {})).rejects.toThrow("does not exist");
});

test("untrusted CLI uses only its authenticated broker, never launches a local worker", async () => {
  const requests: unknown[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { requests.push(await req.json()); return Response.json({ result: { text: "broker page" } }); } });
  let output = "";
  const input = {
    request: { action: "read" as const },
    env: { PHANTOMBOT_TURN_ID: "turn", PHANTOMBOT_PERSONA: "alice", PHANTOMBOT_SECURITY_SESSION: JSON.stringify({ url: `http://127.0.0.1:${server.port}/operation`, token: "a".repeat(64), workspace: "/ignored" }) },
    call: async () => { throw new Error("must not spawn locally"); },
    out: (s: string) => { output += s; }, err: () => {},
  };
  try {
    expect(await runBrowser(input)).toBe(0);
    expect(requests).toEqual([{ kind: "broker", operation: { kind: "browser", request: { action: "read" } } }]);
    expect(JSON.parse(output)).toEqual({ text: "broker page" });
    expect(await runBrowser({ ...input, persona: "bob" })).toBe(1);
    expect(await runBrowser({ ...input, env: { ...input.env, PHANTOMBOT_SECURITY_SESSION: "bad" } })).toBe(1);
    expect(requests).toHaveLength(1);
  } finally { await server.stop(true); }
});

test("CLI routes tabs by conversation and validates before invoking a worker", async () => {
  const root = await temp(); await mkdir(join(root, "alice"));
  const requests: unknown[] = []; let output = "";
  const input = {
    config: { personasDir: root, defaultPersona: "alice" } as Config,
    env: { PHANTOMBOT_CONVERSATION: "chat:a", PHANTOMBOT_TRUSTED: "1" },
    call: async (_: string, request: unknown) => { requests.push(request); return { text: "ok" }; },
    out: (s: string) => { output += s; }, err: () => {},
  };
  expect(await runBrowser({ ...input, request: { action: "open", url: "https://example.com" } })).toBe(0);
  expect(requests[0]).toMatchObject({ session: new Bun.CryptoHasher("sha256").update("chat:a").digest("hex") });
  expect(JSON.parse(output)).toEqual({ text: "ok" });
  expect(await runBrowser({ ...input, request: { action: "open", url: "file:///etc/passwd" } })).toBe(1);
  expect(requests.length).toBe(1);
});

test("transport rejects unauthenticated, cross-origin and malformed requests; idle removes endpoint", async () => {
  const root = await temp();
  const daemon = runBrowserDaemon(root, 300);
  let endpoint: { port: number; token: string } | undefined;
  for (let i = 0; i < 100 && !endpoint; i++) {
    try { endpoint = JSON.parse(await readFile(join(root, "endpoint.json"), "utf8")); } catch { await Bun.sleep(5); }
  }
  expect(endpoint).toBeDefined();
  const url = `http://127.0.0.1:${endpoint!.port}/call`;
  const headers = { Authorization: `Bearer ${endpoint!.token}` };
  expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(403);
  expect((await fetch(url, { method: "POST", headers: { ...headers, Origin: "https://evil.example" }, body: "{}" })).status).toBe(403);
  expect((await fetch(url, { method: "POST", headers, body: JSON.stringify({ action: "open", url: "file:///x" }) })).status).toBe(400);
  await daemon;
  await expect(readFile(join(root, "endpoint.json"))).rejects.toThrow();
});

describe("issue #810 session fixes", () => {
  /** A fake view that emits CDP page events like Chrome does after Enter. */
  function eventRuntime(opts: { navigateOnPress?: boolean; frame?: string; stopAfterMs?: number; clickError?: string; hitPoint?: unknown; dead?: boolean } = {}) {
    const fake = fakeRuntime();
    const listeners = new Map<string, Set<(e: Event) => void>>();
    const state = { title: "Home", stoppedAt: 0, snapshotAt: 0 };
    const emit = (type: string, frameId: string) => { for (const l of listeners.get(type) ?? []) l(new MessageEvent(type, { data: { frameId } })); };
    class View extends (fake.runtime as unknown as { new(v: unknown): BrowserView }) {
      addEventListener(type: string, l: (e: Event) => void) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(l); }
      removeEventListener(type: string, l: (e: Event) => void) { listeners.get(type)?.delete(l); }
      override async cdp(method: string, params?: unknown) {
        fake.calls.push([method, params]);
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
        return {};
      }
      override async press(key: string) {
        fake.calls.push(["press", key]);
        if (!opts.navigateOnPress) return;
        const frame = opts.frame ?? "main";
        emit("Page.frameRequestedNavigation", frame);
        setTimeout(() => { emit("Page.frameStartedLoading", frame); }, 20);
        setTimeout(() => { if (frame === "main") state.title = "Results"; state.stoppedAt = Date.now(); emit("Page.frameStoppedLoading", frame); }, opts.stopAfterMs ?? 120);
      }
      override async click(selector: string | number, y?: number | { timeout: number }) {
        if (typeof selector === "number") { fake.calls.push(["clickAt", selector, y]); return; }
        fake.calls.push(["click", selector]);
        if (opts.clickError) throw new Error(opts.clickError);
      }
      override async evaluate(script: string): Promise<unknown> {
        fake.calls.push(["evaluate", script]);
        if (opts.dead && script === "1") throw new Error("Target closed");
        if (script === "navigator.userAgent") return "HeadlessChrome/156.0.0.0";
        if (script.includes("elementFromPoint")) return opts.hitPoint ?? null;
        if (script.includes("location.href, title: document.title")) return { url: "https://example.com/live", title: state.title };
        state.snapshotAt = Date.now();
        return { title: state.title };
      }
    }
    return { ...fake, runtime: View as unknown as WebViewRuntime, state, listeners };
  }

  test("press Enter returns the page AFTER the main-frame navigation it started", async () => {
    const fake = eventRuntime({ navigateOnPress: true });
    const sessions = new BrowserSessions(await temp(), fake.runtime);
    await sessions.execute({ action: "open", url: "https://example.com" });
    expect(await sessions.execute({ action: "press", key: "Enter" })).toEqual({ title: "Results" });
    expect(fake.state.snapshotAt).toBeGreaterThanOrEqual(fake.state.stoppedAt);
    // Listeners are removed after every action.
    for (const set of fake.listeners.values()) expect(set.size).toBe(0);
    sessions.closeAll();
  });

  test("an iframe navigation is not waited for; a press with no navigation returns after the short grace", async () => {
    const fake = eventRuntime({ navigateOnPress: true, frame: "ad-iframe", stopAfterMs: 2000 });
    const sessions = new BrowserSessions(await temp(), fake.runtime);
    await sessions.execute({ action: "open", url: "https://example.com" });
    const started = Date.now();
    expect(await sessions.execute({ action: "press", key: "Enter" })).toEqual({ title: "Home" });
    // Grace only (300 ms), never the iframe's 2 s load.
    expect(Date.now() - started).toBeLessThan(1000);
    sessions.closeAll();
  });

  test("a failed selector keeps the tab, its page and its identity", async () => {
    const fake = eventRuntime({ clickError: "timeout waiting for '#missing' to be actionable" });
    const sessions = new BrowserSessions(await temp(), fake.runtime);
    await sessions.execute({ action: "open", url: "https://example.com" });
    await expect(sessions.execute({ action: "click", selector: "#missing" })).rejects.toThrow("(the tab is still open)");
    expect(fake.calls.some(c => c[0] === "close" || c[0] === "closeAll")).toBe(false);
    expect(await sessions.execute({ action: "read" })).toEqual({ title: "Home" });
    expect(sessions.chromeGone).toBe(false);
    sessions.closeAll();
  });

  test("a tab that no longer answers is closed and marks Chrome gone", async () => {
    const fake = eventRuntime({ clickError: "Chrome process closed the pipe", dead: true });
    const sessions = new BrowserSessions(await temp(), fake.runtime);
    await sessions.execute({ action: "open", url: "https://example.com" });
    await expect(sessions.execute({ action: "click", selector: "#x" })).rejects.toThrow("closed the pipe");
    expect(fake.calls.some(c => c[0] === "closeAll")).toBe(true);
    expect(sessions.chromeGone).toBe(true);
    await expect(sessions.execute({ action: "read" })).rejects.toThrow("not open");
  });

  test("click falls back to the hit-tested center only when Bun's actionability wait gives up", async () => {
    const actionable = "timeout waiting for 'input[name=\"q\"]' to be actionable";
    let fake = eventRuntime({ clickError: actionable, hitPoint: { x: 640, y: 42 } });
    let sessions = new BrowserSessions(await temp(), fake.runtime);
    await sessions.execute({ action: "open", url: "https://example.com" });
    await sessions.execute({ action: "click", selector: "input[name=\"q\"]" });
    expect(fake.calls.find(c => c[0] === "clickAt")).toEqual(["clickAt", 640, 42]);
    const script = fake.calls.find(c => c[0] === "evaluate" && String(c[1]).includes("elementFromPoint"))![1] as string;
    expect(script).toContain(JSON.stringify("input[name=\"q\"]"));
    sessions.closeAll();
    // Obscured or missing (hit test returns null): the original error stands.
    fake = eventRuntime({ clickError: actionable, hitPoint: null });
    sessions = new BrowserSessions(await temp(), fake.runtime);
    await sessions.execute({ action: "open", url: "https://example.com" });
    await expect(sessions.execute({ action: "click", selector: "input[name=\"q\"]" })).rejects.toThrow("to be actionable");
    expect(fake.calls.some(c => c[0] === "clickAt")).toBe(false);
    sessions.closeAll();
  });

  test("screenshot metadata comes from the live document, not Bun's last-navigation cache", async () => {
    const fake = eventRuntime();
    const sessions = new BrowserSessions(await temp(), fake.runtime);
    await sessions.execute({ action: "open", url: "https://example.com" });
    fake.state.title = "Results";
    expect(await sessions.execute({ action: "screenshot" })).toMatchObject({ url: "https://example.com/live", title: "Results" });
    sessions.closeAll();
  });

  test("a browser that never launches reports CHROME_START_FAILED and marks Chrome gone", async () => {
    const fake = fakeRuntime();
    class Broken extends (fake.runtime as unknown as { new(v: unknown): BrowserView }) { override async navigate(): Promise<unknown> { throw new Error("Chrome process closed the pipe"); } }
    const sessions = new BrowserSessions(await temp(), Broken as unknown as WebViewRuntime);
    await expect(sessions.execute({ action: "open", url: "https://example.com" })).rejects.toThrow(`${CHROME_START_FAILED}: Chrome process closed the pipe`);
    expect(sessions.chromeGone).toBe(true);
  });
});

describe("issue #810 review follow-ups", () => {
  function scripted(answers: { ready?: unknown[]; snapshots?: unknown[]; focus?: unknown }) {
    const fake = fakeRuntime();
    const ready = [...(answers.ready ?? [])], snapshots = [...(answers.snapshots ?? [])];
    class View extends (fake.runtime as unknown as { new(v: unknown): BrowserView }) {
      override async evaluate(script: string): Promise<unknown> {
        fake.calls.push(["evaluate", script]);
        if (script === "navigator.userAgent") return "HeadlessChrome/156.0.0.0";
        if (script === "document.readyState") return ready.length ? ready.shift() : "complete";
        if (script === FOCUS_SCRIPT) return answers.focus;
        if (script === SNAPSHOT_SCRIPT) return snapshots.length > 1 ? snapshots.shift() : snapshots[0] ?? { text: "fixture", elements: [] };
        return undefined;
      }
    }
    return { ...fake, runtime: View as unknown as WebViewRuntime };
  }

  test("open waits for the document to finish loading before the snapshot", async () => {
    const fake = scripted({ ready: ["loading", "interactive", "complete"], snapshots: [{ text: "Loaded", elements: [] }] });
    const sessions = new BrowserSessions(await temp(), fake.runtime);
    expect(await sessions.execute({ action: "open", url: "https://example.com" })).toEqual({ text: "Loaded", elements: [] });
    const order = fake.calls.filter(c => c[0] === "evaluate" && (c[1] === "document.readyState" || c[1] === SNAPSHOT_SCRIPT)).map(c => c[1] === SNAPSHOT_SCRIPT ? "snapshot" : "ready");
    expect(order).toEqual(["ready", "ready", "ready", "snapshot"]);
    sessions.closeAll();
  });

  test("open retries an empty snapshot of a ready page instead of returning it", async () => {
    const empty = { text: "", elements: [] };
    const fake = scripted({ snapshots: [empty, empty, { text: "Hydrated", elements: [{ tag: "a" }] }] });
    const sessions = new BrowserSessions(await temp(), fake.runtime);
    expect(await sessions.execute({ action: "open", url: "https://example.com" })).toEqual({ text: "Hydrated", elements: [{ tag: "a" }] });
    sessions.closeAll();
  });

  test("type with nothing editable focused errors and sends no keystrokes; a focused input types", async () => {
    let fake = scripted({ focus: { editable: false, tag: "body" } });
    let sessions = new BrowserSessions(await temp(), fake.runtime);
    await sessions.execute({ action: "open", url: "https://example.com" });
    await expect(sessions.execute({ action: "type", text: "lost" })).rejects.toThrow("Nothing editable is focused");
    expect(fake.calls.some(c => c[0] === "type")).toBe(false);
    sessions.closeAll();
    for (const focus of [{ editable: true, tag: "input" }, { editable: null, tag: "iframe" }]) {
      fake = scripted({ focus });
      sessions = new BrowserSessions(await temp(), fake.runtime);
      await sessions.execute({ action: "open", url: "https://example.com" });
      await sessions.execute({ action: "type", text: "kept" });
      expect(fake.calls).toContainEqual(["type", "kept"]);
      sessions.closeAll();
    }
  });

  test("stop returns only after the worker released its endpoint and lock, so the next start wins", async () => {
    const root = await temp();
    const first = runBrowserDaemon(root);
    let endpoint: { port: number; token: string } | undefined;
    for (let i = 0; i < 200 && !endpoint; i++) {
      try { endpoint = JSON.parse(await readFile(join(root, "endpoint.json"), "utf8")); } catch { await Bun.sleep(5); }
    }
    expect(endpoint).toBeDefined();
    expect(await browserCall(root, { action: "stop" })).toEqual({ stopped: true });
    // No sleep: the old endpoint must already be gone and the lock free.
    await expect(fetch(`http://127.0.0.1:${endpoint!.port}/health`, { headers: { Authorization: `Bearer ${endpoint!.token}` } })).rejects.toThrow();
    await expect(readFile(join(root, "endpoint.json"))).rejects.toThrow();
    const lock = acquireRunLock(join(root, "worker.lock"));
    expect("release" in lock).toBe(true);
    if ("release" in lock) lock.release();
    await first;
    // A replacement worker started immediately serves calls.
    const second = runBrowserDaemon(root, 300);
    let next: { port: number; token: string } | undefined;
    for (let i = 0; i < 200 && !next; i++) {
      try { next = JSON.parse(await readFile(join(root, "endpoint.json"), "utf8")); } catch { await Bun.sleep(5); }
    }
    expect(next?.token).not.toBe(endpoint!.token);
    await second;
  });
});
