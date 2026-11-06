/**
 * #770: `phantombot device list` must exit on its own once it has answered,
 * even when a relay is still mid-handshake or timed out connecting.
 *
 * Real local WebSocket relays and a real child CLI, because the bug is a
 * socket keeping the process alive: a fake pool cannot show it. The child runs
 * against a throwaway HOME/XDG tree and a generated identity, never real ones.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateIdentity } from "../src/lib/nostrIdentity.ts";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");

/** A minimal relay: EOSE every REQ, OK every EVENT, after an optional handshake delay. */
function relay(handshakeDelayMs: number) {
  return Bun.serve({
    port: 0,
    async fetch(req, server) {
      if (handshakeDelayMs > 0) await Bun.sleep(handshakeDelayMs);
      if (server.upgrade(req)) return undefined;
      return new Response("relay", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        let msg: unknown;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (!Array.isArray(msg)) return;
        if (msg[0] === "REQ") ws.send(JSON.stringify(["EOSE", msg[1]]));
        if (msg[0] === "EVENT") ws.send(JSON.stringify(["OK", msg[1]?.id, true, ""]));
      },
    },
  });
}

let root: string;
let servers: Array<ReturnType<typeof Bun.serve>>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pb-device-exit-"));
  servers = [];
});

afterEach(() => {
  for (const s of servers) s.stop(true);
  rmSync(root, { recursive: true, force: true });
});

/** Run `device list` against the given relays; resolves with whether it exited by itself. */
async function deviceList(relays: string[], wait: string, budgetMs: number) {
  const personas = join(root, "personas");
  const dir = join(personas, "t");
  mkdirSync(join(dir, "memory"), { recursive: true });
  writeFileSync(join(dir, "identity.json"), JSON.stringify({ nsec: generateIdentity().nsec }));
  writeFileSync(
    join(dir, "phantomchat.json"),
    JSON.stringify({ relays, allowed_npubs: [generateIdentity().npub] }),
  );
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    PHANTOMBOT_PERSONAS_DIR: personas,
  };
  const child = Bun.spawn(
    [process.execPath, ENTRY, "device", "list", "--persona", "t", "--wait", wait],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    child.kill("SIGKILL");
  }, budgetMs);
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  clearTimeout(timer);
  return { killed, code, stdout };
}

describe("device list exits by itself (#770)", () => {
  test("with a relay still mid-handshake when the command finishes", async () => {
    servers.push(relay(0), relay(800));
    const urls = servers.map((s) => `ws://127.0.0.1:${s.port}`);
    const r = await deviceList(urls, "0.1", 8000);
    expect(r.killed).toBe(false);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("no devices online");
  }, 15_000);

  test("with a relay that outlasts the connect timeout", async () => {
    servers.push(relay(0), relay(2600));
    const urls = servers.map((s) => `ws://127.0.0.1:${s.port}`);
    const r = await deviceList(urls, "2.2", 10_000);
    expect(r.killed).toBe(false);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("no devices online");
  }, 15_000);
});
