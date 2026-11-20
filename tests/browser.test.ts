import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSessions, type BrowserView, type WebViewRuntime, validateRequest } from "../src/browser/session.ts";
import { browserChildEnv, runBrowserDaemon } from "../src/browser/daemon.ts";
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
    async click(selector: string) { calls.push(["click", selector]); }
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
  for (const value of [null, [], { action: "nope" }, { action: "open" }, { action: "read", session: "../a" }, { action: "scroll", dy: NaN }, { action: "resize", width: 1e8, height: 800 }]) expect(() => validateRequest(value)).toThrow();
});

test("Citty accepts actions with no positional value", async () => {
  const args = typeof browserCommand.args === "function" ? await browserCommand.args() : browserCommand.args;
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
