/**
 * GHSA-w7w8 close-out (#783): untrusted turns run sandboxed by default, with
 * network and the persona's vault in the sandbox env.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTurn } from "../src/orchestrator/turn.ts";
import type { ScreenVerdict } from "../src/orchestrator/screen.ts";
import { type MemoryStore, openMemoryStore } from "../src/memory/store.ts";
import type { Harness, HarnessChunk, HarnessRequest } from "../src/harnesses/types.ts";
import { readSecurityPolicy, setDefaultSecurityPolicyForTests } from "../src/security/policy.ts";
import { createSecuritySession } from "../src/security/session.ts";
import { openPersonaVault } from "../src/lib/vault.ts";

// The suite preload opts mock-harness fixtures out; this file tests the REAL default.
beforeAll(() => setDefaultSecurityPolicyForTests(undefined));
afterAll(() => setDefaultSecurityPolicyForTests(() => ({ version: 1, enabled: false, grants: [] })));

let agentDir: string;
let memory: MemoryStore;
beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "phantombot-sbx-default-"));
  await writeFile(join(agentDir, "BOOT.md"), "# I am Phantom", "utf8");
  memory = await openMemoryStore(":memory:");
});
afterEach(async () => {
  await memory.close();
  await rm(agentDir, { recursive: true, force: true });
});

function recorder(id: string, caps: { sandbox?: boolean }) {
  const reqs: HarnessRequest[] = [];
  const h: Harness = {
    id,
    ...(caps.sandbox ? { supportsSecuritySession: true } : {}),
    available: async () => true,
    async *invoke(req: HarnessRequest): AsyncGenerator<HarnessChunk> {
      reqs.push(req);
      yield { type: "done", finalText: `from ${id}` };
    },
  };
  return { h, reqs };
}

async function turn(harnesses: Harness[], verdict: ScreenVerdict, trusted = false) {
  let final = "";
  for await (const c of runTurn({
    persona: "phantom",
    conversation: "cli:default",
    agentDir,
    workingDir: agentDir,
    memory,
    idleTimeoutMs: 1_000,
    hardTimeoutMs: 5_000,
    userMessage: "review the PR",
    harnesses,
    ...(trusted ? { trusted: true } : {}),
    screen: async () => verdict,
  } as Parameters<typeof runTurn>[0])) {
    if (c.type === "done") final = c.finalText;
  }
  return final;
}

describe("default-on sandbox for untrusted turns", () => {
  test("no policy file = enabled, no grants needed", () => {
    expect(readSecurityPolicy(agentDir)).toEqual({ version: 1, enabled: true, grants: [] });
  });

  test("an untrusted turn runs sandboxed, told where its host commands went", async () => {
    const a = recorder("native", { sandbox: true });
    await turn([a.h], { action: "pass", score: 5, reason: "ok" });
    expect(a.reqs).toHaveLength(1);
    expect(a.reqs[0]!.securitySession?.workspace).toContain(join("scratch", "untrusted"));
    expect(a.reqs[0]!.systemPrompt).toContain("# Sandboxed turn");
  });

  test("a harness that cannot run sandboxed is left out; none left = held, never unsandboxed", async () => {
    const codex = recorder("codex", {});
    const final = await turn([codex.h], { action: "pass", score: 5, reason: "ok" });
    expect(codex.reqs).toHaveLength(0);
    expect(final).toContain("paused");
  });

  test("the sandbox's only writable dir is the turn's untrusted scratch", async () => {
    const a = recorder("native", { sandbox: true });
    await turn([a.h], { action: "pass", score: 5, reason: "ok" });
    const req = a.reqs[0]!;
    expect(req.scratchDir).toBeDefined();
    expect(req.scratchDir!).toContain(join("scratch", "untrusted"));
    // Same dir (the session holds its realpath; both are gone after the turn).
    expect(req.securitySession!.workspace).toEndWith(req.scratchDir!.slice(agentDir.length));
    expect(req.systemPrompt).toContain("ONLY writable place");
  });

  test("trusted turns are never sandboxed", async () => {
    const a = recorder("native", { sandbox: true });
    await turn([a.h], { action: "pass", score: 0, reason: "" }, true);
    expect(a.reqs[0]!.securitySession).toBeUndefined();
    expect(a.reqs[0]!.systemPrompt).not.toContain("# Sandboxed turn");
  });

  test("enabled:false is the owner's opt-out", async () => {
    await writeFile(join(agentDir, "security-policy.json"), JSON.stringify({ version: 1, enabled: false, grants: [] }));
    const a = recorder("native", { sandbox: true });
    await turn([a.h], { action: "pass", score: 5, reason: "ok" });
    expect(a.reqs[0]!.securitySession).toBeUndefined();
  });
});

describe("session: vault in", () => {
  async function post(session: Awaited<ReturnType<typeof createSecuritySession>>, body: unknown) {
    const r = await fetch(session.descriptor.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.descriptor.token}` },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  }

  test("a sandboxed command gets the persona's vault secrets", async () => {
    const v = await openPersonaVault(agentDir);
    v.set("PROBE_VAULT_SECRET", "vault-value-7");
    v.close();
    const session = await createSecuritySession({ personaDir: agentDir, policy: { version: 1, enabled: true, grants: [] } });
    try {
      const r = await post(session, {
        kind: "sandbox",
        command: process.platform === "win32" ? "echo %PROBE_VAULT_SECRET%" : 'echo "$PROBE_VAULT_SECRET"',
      });
      expect(r.status).toBe(200);
      expect(String(r.json.output)).toContain("vault-value-7");
    } finally {
      await session.close();
    }
  }, 20000);

  test("a workspace outside untrusted scratch is refused", async () => {
    const outside = join(agentDir, "not-scratch");
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(agentDir, "scratch", "untrusted"), { recursive: true });
    await expect(
      createSecuritySession({ personaDir: agentDir, policy: { version: 1, enabled: true, grants: [] }, workspace: outside }),
    ).rejects.toThrow("untrusted scratch");
    await expect(
      createSecuritySession({ personaDir: agentDir, policy: { version: 1, enabled: true, grants: [] }, workspace: agentDir }),
    ).rejects.toThrow("untrusted scratch");
  });
});

test("a persona with no vault runs sandboxed commands without provisioning one", async () => {
  const { existsSync } = await import("node:fs");
  const session = await createSecuritySession({ personaDir: agentDir, policy: { version: 1, enabled: true, grants: [] } });
  try {
    const r = await fetch(session.descriptor.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.descriptor.token}` },
      body: JSON.stringify({ kind: "sandbox", command: "echo no-vault-ok" }),
    });
    expect(await r.text()).toContain("no-vault-ok");
    expect(existsSync(join(agentDir, "identity.json"))).toBe(false);
    expect(existsSync(join(agentDir, "vault.sqlite"))).toBe(false);
  } finally {
    await session.close();
  }
}, 20000);
