/**
 * GHSA-w7w8 close-out (#783): untrusted turns run sandboxed by default, with
 * network and the persona's vault in the sandbox env. The escort (when on)
 * judges each sandbox command and broker host action at the session boundary.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTurn } from "../src/orchestrator/turn.ts";
import type { ScreenVerdict } from "../src/orchestrator/screen.ts";
import { type MemoryStore, openMemoryStore } from "../src/memory/store.ts";
import type { Harness, HarnessChunk, HarnessRequest } from "../src/harnesses/types.ts";
import { readSecurityPolicy, setDefaultSecurityPolicyForTests } from "../src/security/policy.ts";
import { createSecuritySession } from "../src/security/session.ts";
import { sessionEscortGate } from "../src/security/escortGate.ts";
import { openPersonaVault } from "../src/lib/vault.ts";
import type { EscortSettings } from "../src/lib/escort.ts";

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

const SETTINGS: EscortSettings = {
  baseUrl: "https://jev.test/api/v1",
  model: "typesafe/jev-1.13",
  keyEnv: "TEST_JEV_KEY",
  timeoutMs: 500,
  threshold: 90,
};

function recorder(id: string, caps: { sandbox?: boolean; escort?: boolean }) {
  const reqs: HarnessRequest[] = [];
  const h: Harness = {
    id,
    ...(caps.sandbox ? { supportsSecuritySession: true } : {}),
    ...(caps.escort ? { supportsEscort: true } : {}),
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
    const a = recorder("native", { sandbox: true, escort: true });
    await turn([a.h], { action: "pass", score: 5, reason: "ok", escort: SETTINGS });
    expect(a.reqs).toHaveLength(1);
    expect(a.reqs[0]!.securitySession?.workspace).toStartWith(join(agentDir, "sandbox"));
    // The escort runs at the session boundary, not in the harness.
    expect(a.reqs[0]!.escort).toBeUndefined();
    expect(a.reqs[0]!.systemPrompt).toContain("# Sandboxed turn");
  });

  test("a harness that cannot run sandboxed is left out; none left = held, never unsandboxed", async () => {
    const codex = recorder("codex", { escort: false });
    const final = await turn([codex.h], { action: "pass", score: 5, reason: "ok" });
    expect(codex.reqs).toHaveLength(0);
    expect(final).toContain("paused");
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

describe("session: vault in, escort at the boundary", () => {
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

  test("a refused command never runs; the model gets the refusal", async () => {
    const seen: unknown[] = [];
    const session = await createSecuritySession({
      personaDir: agentDir,
      policy: { version: 1, enabled: true, grants: [] },
      gate: async (action) => {
        seen.push(action);
        return "Blocked by phantombot's escort: test";
      },
    });
    try {
      const r = await post(session, { kind: "sandbox", command: "echo should-not-run > ran.txt" });
      expect(r.status).toBe(409);
      expect(String(r.json.error)).toContain("Blocked by phantombot's escort");
      expect(seen).toEqual([{ tool: "bash", input: { command: "echo should-not-run > ran.txt" } }]);
    } finally {
      await session.close();
    }
  }, 20000);

  test("every host action is judged before it runs; deny-all refuses each one", async () => {
    const seen: { tool: string; input: unknown }[] = [];
    const far = Date.now() + 3_600_000;
    const session = await createSecuritySession({
      personaDir: agentDir,
      policy: {
        version: 1,
        enabled: true,
        grants: [
          { id: "npm", kind: "npm-registry", expiresAt: far },
          { id: "gh", kind: "github-review", repository: "o/r", pullRequest: 1, expiresAt: far },
          { id: "h", kind: "http", url: "https://example.invalid/x", method: "POST", expiresAt: far },
          { id: "m", kind: "mcp", server: "s", tool: "t", arguments: {}, expiresAt: far },
        ],
      },
      gate: async (action) => {
        seen.push(action);
        return "Blocked by phantombot's escort: deny-all";
      },
    });
    const head = "a".repeat(40);
    const ops: Record<string, unknown>[] = [
      { kind: "notify", message: "hi" },
      { kind: "memory-capture", text: "t", tags: ["lesson"] },
      { kind: "memory-search", query: "q" },
      { kind: "npm-package", grant: "npm", name: "left-pad", version: "1.3.0" },
      { kind: "github-read", grant: "gh", resource: "pull" },
      { kind: "github-checkout", grant: "gh", head },
      { kind: "github-review", grant: "gh", head, event: "COMMENT", body: "b" },
      { kind: "http", grant: "h", body: "payload" },
      { kind: "mcp", grant: "m", arguments: {} },
    ];
    try {
      for (const operation of ops) {
        const before = seen.length;
        const r = await post(session, { kind: "broker", operation });
        expect(r.status).toBe(409);
        // The gate's own refusal: it ran, and refused, before the action.
        expect(String(r.json.error)).toContain("deny-all");
        expect(seen.length).toBe(before + 1);
      }
      expect(seen.slice(0, 3).map((a) => String((a.input as { command: string }).command).split(" ").slice(0, 3).join(" "))).toEqual([
        "phantombot notify --message",
        "phantombot memory capture",
        "phantombot memory search",
      ]);
      for (const [i, a] of seen.slice(3).entries()) {
        expect(a.tool).toBe("broker");
        expect(String((a.input as { operation: string }).operation)).toStartWith(`broker ${String(ops[i + 3]!.kind)} via grant`);
      }
    } finally {
      await session.close();
    }
  }, 20000);

  test("the escort gate holds at the threshold and passes below it", async () => {
    const answer = (level: number) =>
      (async () =>
        new Response(
          JSON.stringify({ answers: { score: { type: "score", score: level } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as never;
    const env = { TEST_JEV_KEY: "k" };
    const ctx = { ...SETTINGS, task: "fix the PR" };
    const action = { tool: "bash", input: { command: "git push origin fix" } };
    // level 7 → 78/100: doubtful, not held at 90.
    expect(await sessionEscortGate(ctx, { env, fetchImpl: answer(7) })(action)).toBeUndefined();
    // level 9 → 100/100: held.
    expect(await sessionEscortGate(ctx, { env, fetchImpl: answer(9) })(action)).toContain("Blocked by phantombot's escort");
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
