/** Local, authenticated transport. Each persona (or untrusted scratch) owns a
 * separate process because Bun.WebView shares Chrome/profile process-wide. */
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { acquireRunLock } from "../lib/runLock.ts";
import { isCompiledBinary } from "../lib/embeddedPi.ts";
import { BrowserSessions, type BrowserRequest, validateRequest } from "./session.ts";

export const BROWSER_SUBCOMMAND = "__browser";
export const BROWSER_IDLE_MS = 5 * 60_000;
interface Endpoint { port: number; token: string }

async function endpoint(root: string): Promise<Endpoint | undefined> {
  try {
    const value = JSON.parse(await readFile(join(root, "endpoint.json"), "utf8")) as Endpoint;
    if (Number.isInteger(value.port) && value.port > 0 && value.port <= 65535 && /^[a-f0-9]{64}$/.test(value.token)) return value;
  } catch { /* absent or stale; health check below decides */ }
  return undefined;
}

async function health(e: Endpoint): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${e.port}/health`, { headers: { Authorization: `Bearer ${e.token}` }, signal: AbortSignal.timeout(500), redirect: "error" });
    return r.ok && (await r.text()) === "phantombot-browser";
  } catch { return false; }
}

/** Browser children need OS environment, not the persona's decrypted vault. */
export function browserChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = ["PATH", "Path", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "PROGRAMFILES", "ProgramFiles", "ProgramFiles(x86)", "SYSTEMROOT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XDG_CACHE_HOME", "BUN_CHROME_PATH", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];
  return Object.fromEntries(names.filter(n => env[n] !== undefined).map(n => [n, env[n]]));
}

export async function browserCall(root: string, request: BrowserRequest): Promise<unknown> {
  validateRequest(request);
  let e = await endpoint(root);
  if (!e || !await health(e)) {
    if (request.action === "stop" || request.action === "close") return { closed: true, running: false };
    await mkdir(root, { recursive: true, mode: 0o700 });
    const args = isCompiledBinary() ? [] : [resolve(import.meta.dir, "..", "index.ts")];
    const log = openSync(join(root, "worker.log"), "w", 0o600);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [...args, BROWSER_SUBCOMMAND, root], {
        detached: true, stdio: ["ignore", "ignore", log], env: browserChildEnv(process.env), windowsHide: true,
      });
    } finally { closeSync(log); }
    let spawnError: Error | undefined;
    child.on("error", error => { spawnError = error; });
    child.unref();
    const deadline = Date.now() + 10_000;
    e = undefined;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      const candidate = await endpoint(root);
      if (candidate && await health(candidate)) { e = candidate; break; }
      await Bun.sleep(100);
    }
    if (!e) throw new Error(`Browser worker did not start; see ${join(root, "worker.log")} (requires Bun.WebView)`);
  }
  // Never retry an operation: a disconnected reply can follow a successful click.
  const response = await fetch(`http://127.0.0.1:${e.port}/call`, {
    method: "POST", headers: { Authorization: `Bearer ${e.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(request), signal: AbortSignal.timeout(35_000), redirect: "error",
  });
  const body = await response.json() as { result?: unknown; error?: string };
  if (!response.ok) throw new Error(body.error ?? `Browser worker returned ${response.status}`);
  return body.result;
}

/** Internal entry: bypasses credential bootstrap, config, and persona stores. */
export async function runBrowserDaemon(root: string, idleMs = BROWSER_IDLE_MS): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = acquireRunLock(join(root, "worker.lock"));
  if (!("release" in lock)) return; // Another simultaneous starter won.
  let sessions: BrowserSessions;
  try { sessions = new BrowserSessions(root); } catch (error) { lock.release(); throw error; }
  const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  let pending = 0;
  let closing = false;
  let lastUse = Date.now();
  let chain: Promise<unknown> = Promise.resolve();
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, maxRequestBodySize: 64 * 1024,
    async fetch(req) {
      if (req.headers.has("origin") || req.headers.get("authorization") !== `Bearer ${token}`) return new Response("Forbidden", { status: 403 });
      const path = new URL(req.url).pathname;
      if (path === "/health" && req.method === "GET") return new Response("phantombot-browser");
      if (path !== "/call" || req.method !== "POST") return new Response("Not found", { status: 404 });
      // Do not queue browser mutations: callers retry after a clear busy result,
      // never after an ambiguous timeout waiting behind another operation.
      if (pending || closing) return Response.json({ error: "Browser is busy; retry when the current operation finishes" }, { status: 409 });
      pending++;
      lastUse = Date.now();
      try {
        const request = validateRequest(await req.json());
        chain = sessions.execute(request);
        const result = await chain;
        if (request.action === "stop") { closing = true; setTimeout(finish, 25); }
        return Response.json({ result });
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      } finally { pending--; lastUse = Date.now(); }
    },
  });
  const end = () => { closing = true; finish(); };
  const idle = setInterval(() => {
    if (!pending && Date.now() - lastUse > idleMs) end();
  }, Math.min(1000, idleMs));
  process.once("SIGTERM", end);
  process.once("SIGINT", end);
  try {
    const temporary = join(root, `endpoint-${process.pid}.tmp`);
    await writeFile(temporary, JSON.stringify({ port: server.port, token }), { mode: 0o600 });
    await rename(temporary, join(root, "endpoint.json"));
    await done;
  } finally {
    closing = true;
    clearInterval(idle);
    process.off("SIGTERM", end);
    process.off("SIGINT", end);
    await sessions.shutdown();
    await chain.catch(() => {});
    await server.stop(true);
    await rm(join(root, "endpoint.json"), { force: true });
    lock.release();
  }
}
