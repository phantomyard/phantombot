import { afterEach, expect, test } from "bun:test";
import { forwardToSandboxSession } from "../src/security/sandboxCli.ts";

const token = "a".repeat(64);
let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => server?.stop(true));
const sink = () => {
  const lines: string[] = [];
  return { lines, write: (s: string) => lines.push(s) };
};

test("no session in env: the CLI runs normally", async () => {
  expect(await forwardToSandboxSession({ kind: "notify", message: "x" }, sink(), sink(), {})).toBeUndefined();
});

test("sandboxed CLI forwards memory search and capture to the session", async () => {
  const seen: unknown[] = [];
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.headers.get("authorization") !== `Bearer ${token}`) return new Response(null, { status: 403 });
      const body = (await req.json()) as { operation: { kind: string } };
      seen.push(body);
      return Response.json(body.operation.kind === "memory-search" ? { result: "[hits]" } : { result: { captured: true } });
    },
  });
  const env = {
    PHANTOMBOT_SECURITY_SESSION: JSON.stringify({ url: `http://127.0.0.1:${server.port}/operation`, token, workspace: "/w" }),
  };
  const out = sink();
  expect(await forwardToSandboxSession({ kind: "memory-search", query: "q" }, out, sink(), env)).toBe(0);
  expect(out.lines.join("")).toBe("[hits]\n");
  expect(await forwardToSandboxSession({ kind: "memory-capture", text: "t", tags: ["lesson"] }, out, sink(), env)).toBe(0);
  expect(seen).toEqual([
    { kind: "broker", operation: { kind: "memory-search", query: "q" } },
    { kind: "broker", operation: { kind: "memory-capture", text: "t", tags: ["lesson"] } },
  ]);
});

test("a refused operation fails the CLI with the reason", async () => {
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ error: "denied" }, { status: 409 }) });
  const env = { PHANTOMBOT_SECURITY_SESSION: JSON.stringify({ url: `http://127.0.0.1:${server.port}/operation`, token, workspace: "/w" }) };
  const err = sink();
  expect(await forwardToSandboxSession({ kind: "notify", message: "m" }, sink(), err, env)).toBe(1);
  expect(err.lines.join("")).toContain("denied");
});
