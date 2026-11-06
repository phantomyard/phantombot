import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSecuritySession,
  ENV_SECURITY_SESSION,
} from "../src/security/session.ts";
import { phantombotSecurityExtension } from "../src/security/extension.ts";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
test("real session enforces IPC authentication and cleans workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-session-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const session = await createSecuritySession({
    personaDir: dir,
    policy: { version: 1, enabled: true, grants: [] },
  });
  cleanups.push(() => session.close());
  expect(
    (await fetch(session.descriptor.url, { method: "POST", body: "{}" }))
      .status,
  ).toBe(403);
  const response = await fetch(session.descriptor.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${session.descriptor.token}` },
    body: JSON.stringify({ kind: "sandbox", command: "echo session-ok" }),
  });
  const result = (await response.json()) as {
    exitCode: number;
    output: string;
  };
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain("session-ok");
  await session.close();
  await expect(fetch(session.descriptor.url)).rejects.toThrow();
}, 20000);
test("malformed session blocks every native tool", () => {
  let hook: ((e: { toolName: string; input: unknown }) => unknown) | undefined;
  phantombotSecurityExtension(
    {
      on: (_name, h) => {
        hook = h;
      },
      registerTool: () => {
        throw new Error("must not register");
      },
    },
    { [ENV_SECURITY_SESSION]: "bad" },
  );
  expect(hook!({ toolName: "sandbox", input: {} })).toMatchObject({
    block: true,
  });
});
test("bounded native turn registers only sandbox and broker and blocks all alternate tools", () => {
  const tools: string[] = [];
  let hook: ((e: { toolName: string; input: unknown }) => unknown) | undefined;
  phantombotSecurityExtension(
    {
      on: (_name, h) => {
        hook = h;
      },
      registerTool: (t) => {
        tools.push(t.name);
      },
    },
    {
      [ENV_SECURITY_SESSION]: JSON.stringify({
        url: "http://127.0.0.1:1234/operation",
        token: "a".repeat(64),
        workspace: "/work",
      }),
    },
  );
  expect(tools).toEqual(["sandbox", "broker"]);
  for (const toolName of [
    "bash",
    "read",
    "write",
    "codemode",
    "mcp_call",
    "look_at_image",
  ])
    expect(hook!({ toolName, input: {} })).toMatchObject({ block: true });
  expect(
    hook!({
      toolName: "sandbox",
      input: { command: "escort allow; judge rule" },
    }),
  ).toBeUndefined();
});
