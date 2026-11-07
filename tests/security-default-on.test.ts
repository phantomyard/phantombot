/**
 * GHSA-w7w8 close-out (#783): bounded security is ON by default for untrusted
 * turns, the escort moves to the broker boundary, and the unattended PR loop
 * never meets it. Merge, settings and the default branch are never brokered.
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
import {
  classifyGithubApi,
  graphqlMutationFields,
  WorkflowBroker,
  workflowEscortKind,
} from "../src/security/workflow.ts";
import { brokerEscortGate } from "../src/security/escortGate.ts";
import { escortCheck, type EscortContext, type EscortSettings } from "../src/lib/escort.ts";
import type { NetworkGrant, WorkflowOperation } from "../src/security/types.ts";

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
  threshold: 70,
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

describe("default-on bounded security", () => {
  test("no policy file = enabled with the workflow grants, no host commands", () => {
    const p = readSecurityPolicy(agentDir);
    expect(p.enabled).toBe(true);
    expect(p.grants.map((g) => g.kind).sort()).toEqual(["github", "memory", "notify", "npm-registry"]);
  });

  test("an untrusted turn with no policy file runs bounded: session, no in-harness escort", async () => {
    const a = recorder("native", { sandbox: true, escort: true });
    await turn([a.h], { action: "pass", score: 5, reason: "ok", escort: SETTINGS });
    expect(a.reqs).toHaveLength(1);
    expect(a.reqs[0]!.securitySession?.workspace).toStartWith(join(agentDir, "sandbox"));
    // Inside the sandbox nothing is judged (decision 2).
    expect(a.reqs[0]!.escort).toBeUndefined();
    // It is told to use the broker, not the host commands it does not have.
    expect(a.reqs[0]!.systemPrompt).toContain("# Sandboxed turn");
  });

  test("a harness that cannot run bounded is left out; none left = held, never unsandboxed", async () => {
    const codex = recorder("codex", { escort: false });
    const final = await turn([codex.h], { action: "pass", score: 5, reason: "ok" });
    expect(codex.reqs).toHaveLength(0);
    expect(final).toContain("paused");
  });

  test("trusted turns are never bounded", async () => {
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

const api = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown) =>
  ({ kind: "github-api", grant: "github", method, path, ...(body === undefined ? {} : { body }) }) as Extract<WorkflowOperation, { kind: "github-api" }>;
const R = "phantomyard/phantombot";

describe("GitHub allowlist", () => {
  test("the PR loop is allowed", () => {
    for (const [m, p, b] of [
      ["GET", `/repos/${R}/pulls/1/files?per_page=100`],
      ["POST", `/repos/${R}/pulls`, { title: "t", head: "x", base: "main" }],
      ["PATCH", `/repos/${R}/pulls/1`, { body: "b" }],
      ["POST", `/repos/${R}/pulls/1/reviews`, { event: "APPROVE" }],
      ["POST", `/repos/${R}/pulls/1/comments/9/replies`, { body: "fixed" }],
      ["POST", `/repos/${R}/issues/1/comments`, { body: "x" }],
      ["POST", `/repos/${R}/pulls/1/requested_reviewers`, { reviewers: ["k"] }],
      ["POST", `/repos/${R}/actions/runs/5/rerun-failed-jobs`],
    ] as const)
      expect(() => classifyGithubApi(api(m, p, b), R, true)).not.toThrow();
  });

  test("merge, settings, base change and branch deletes are refused", () => {
    for (const [m, p, b] of [
      ["PUT", `/repos/${R}/pulls/1/merge`],
      ["PATCH", `/repos/${R}`, { default_branch: "x" }],
      ["PATCH", `/repos/${R}/pulls/1`, { base: "release" }],
      ["PATCH", `/repos/${R}/pulls/1`, { state: "closed" }],
      ["DELETE", `/repos/${R}/git/refs/heads/main`],
      ["PUT", `/repos/${R}/collaborators/x`],
      ["GET", `/repos/other/repo/pulls`],
    ] as const)
      expect(() => classifyGithubApi(api(m, p, b), R, true)).toThrow();
  });

  test("GraphQL: allowed mutations pass, merge cannot hide among them", () => {
    const ok = 'mutation R($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }';
    expect(graphqlMutationFields(ok)).toEqual(["resolveReviewThread"]);
    expect(graphqlMutationFields("query { repository(owner: \"a\", name: \"b\") { id } }")).toBeNull();
    const hidden = [
      // a comment between the name and its arguments
      'mutation { resolveReviewThread(input:{threadId:"a"}) { clientMutationId } mergePullRequest #x\n (input:{pullRequestId:"b"}) { clientMutationId } }',
      // commas are GraphQL whitespace
      'mutation { resolveReviewThread(input:{threadId:"a"}) { clientMutationId } mergePullRequest,(input:{pullRequestId:"b"}) { clientMutationId } }',
      // via a fragment on Mutation
      'mutation { ...M } fragment M on Mutation { mergePullRequest(input:{pullRequestId:"b"}) { clientMutationId } }',
      // a non-`input` first argument
      'mutation { enablePullRequestAutoMerge(x: 1, input:{pullRequestId:"b"}) { clientMutationId } }',
    ];
    for (const query of hidden)
      expect(() => classifyGithubApi(api("POST", "/graphql", { query }), "*", true)).toThrow();
    // A string literal is data, never code.
    expect(graphqlMutationFields('mutation { addComment(input:{subjectId:"a", body:"mergePullRequest(input: # x"}) { clientMutationId } }')).toEqual(["addComment"]);
  });

  test("pushing to the default branch is refused before any git runs", async () => {
    const ran: string[][] = [];
    const broker = new WorkflowBroker({
      workspace: agentDir,
      host: async (argv) => (ran.push(argv), { code: 0, stdout: new Uint8Array(), stderr: "" }),
      sandbox: async () => ({ exitCode: 0, output: "" }),
      self: ["phantombot"],
      persona: "phantom",
      personaEnv: async () => ({}),
      secret: async () => "ghp_test_token_value_1234567890",
      fetch: (async () => Response.json({ default_branch: "main" })) as unknown as typeof fetch,
    });
    const grant: NetworkGrant = { id: "github", kind: "github", repository: "*", expiresAt: Number.MAX_SAFE_INTEGER };
    await expect(
      broker.execute(grant, { kind: "github-push", grant: "github", repository: R, directory: "phantombot", branch: "main", sha: "a".repeat(40) }),
    ).rejects.toThrow(/default branch/);
    expect(ran).toHaveLength(0);
  });
});

describe("escort at the broker boundary", () => {
  const CTX: EscortContext = { ...SETTINGS, task: "shepherd PR 1" };
  const G = (kind: "github" | "notify" | "memory"): NetworkGrant => ({ id: kind, kind, repository: "*", expiresAt: Number.MAX_SAFE_INTEGER }) as NetworkGrant;

  function judge(score: number) {
    const seen = { calls: 0 };
    const fetchImpl = (async () => {
      seen.calls++;
      return Response.json({ answers: { score: { type: "score", score, legend: {}, probabilities: {}, confidence: 0.9 } } });
    }) as unknown as typeof fetch;
    return { seen, opts: { env: { TEST_JEV_KEY: "k" } as NodeJS.ProcessEnv, fetchImpl } };
  }

  test("the PR loop and notify are never judged, even with nothing allowed", async () => {
    const j = judge(9);
    const gate = brokerEscortGate(CTX, [], j.opts);
    for (const op of [
      api("POST", `/repos/${R}/pulls/1/reviews`, { event: "APPROVE" }),
      api("POST", `/repos/${R}/pulls`, { title: "t", head: "x", base: "main" }),
      api("POST", "/graphql", { query: 'mutation { resolveReviewThread(input:{threadId:"a"}) { clientMutationId } }' }),
      { kind: "github-push", grant: "github", repository: R, directory: "d", branch: "fix", sha: "a".repeat(40) },
      { kind: "github-clone", grant: "github", repository: R },
    ] as WorkflowOperation[])
      await gate(G("github"), op);
    await gate(G("notify"), { kind: "notify", grant: "notify", message: "PR 1 is merge-ready" });
    expect(j.seen.calls).toBe(0);
  });

  test("a memory write is judged; a risky one is refused", async () => {
    const j = judge(9);
    const gate = brokerEscortGate(CTX, [], j.opts);
    await expect(gate(G("memory"), { kind: "memory-capture", grant: "memory", text: "x", tags: ["norm"] })).rejects.toThrow();
    expect(j.seen.calls).toBe(1);
  });

  test("an allowed kind skips the judge; a denied kind outranks the allowance", async () => {
    const j = judge(9);
    await brokerEscortGate(CTX, ["memory"], j.opts)(G("memory"), { kind: "memory-capture", grant: "memory", text: "x", tags: ["lesson"] });
    expect(j.seen.calls).toBe(0);
    await expect(
      brokerEscortGate({ ...CTX, deny: ["memory"] }, ["memory"], j.opts)(G("memory"), { kind: "memory-capture", grant: "memory", text: "x", tags: ["lesson"] }),
    ).rejects.toThrow();
  });

  test("brokered text that merely NAMES the allowances is not auto-refused (decision 4)", async () => {
    const j = judge(1);
    const action = { tool: "broker", input: { kind: "memory-capture", text: "ran phantombot escort allow push" } };
    expect((await escortCheck(CTX, action, { ...j.opts, brokered: { kind: "memory" } })).allow).toBe(true);
    expect((await escortCheck(CTX, action, j.opts)).allow).toBe(false);
  });

  test("operation kinds map as documented", () => {
    expect(workflowEscortKind({ kind: "memory-capture", grant: "m", text: "x" })).toBe("memory");
    expect(workflowEscortKind({ kind: "host-command", grant: "h" })).toBe("shell");
    expect(workflowEscortKind({ kind: "notify", grant: "n", message: "x" })).toBeUndefined();
    expect(workflowEscortKind({ kind: "github-push", grant: "g", repository: R, directory: "d", branch: "b", sha: "a".repeat(40) })).toBeUndefined();
  });
});
