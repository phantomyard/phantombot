import { describe, expect, test } from "bun:test";
import { CapabilityBroker, SandboxArchive } from "../src/security/broker.ts";
import { validatePolicy } from "../src/security/policy.ts";
import type { NetworkGrant, SecurityPolicy } from "../src/security/types.ts";
const head = "a".repeat(40);
const grant: NetworkGrant = {
  id: "review",
  kind: "github-review",
  repository: "phantomyard/phantombot",
  pullRequest: 12,
  expiresAt: 2000,
};
const policy = (grants: NetworkGrant[] = [grant]): SecurityPolicy => ({
  version: 1,
  enabled: true,
  grants,
});
function rig(
  grants?: NetworkGrant[],
  reply: (url: string, init?: RequestInit) => unknown = (url) =>
    url.includes("/reviews")
      ? { id: 42 }
      : { state: "open", head: { sha: head } },
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const audits: unknown[] = [];
  const broker = new CapabilityBroker(policy(grants), {
    now: () => 1000,
    secret: () => "sensitive-key",
    audit: (e) => audits.push(e),
    fetch: (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Response.json(reply(String(url), init));
    }) as unknown as typeof fetch,
  });
  return { broker, calls, audits };
}
describe("deterministic grants", () => {
  test("authorized review has no classifier and is bound to target/head", async () => {
    const { broker, calls, audits } = rig();
    await broker.execute({
      kind: "github-review",
      grant: "review",
      head,
      event: "APPROVE",
      body: "Verified.",
    });
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/phantomyard/phantombot/pulls/12",
      "https://api.github.com/repos/phantomyard/phantombot/pulls/12/reviews",
    ]);
    expect(JSON.parse(String(calls[1]!.init!.body)).commit_id).toBe(head);
    expect(audits).toMatchObject([{ outcome: "allowed" }]);
  });
  test("wrong grant refuses before network", async () => {
    const { broker, calls } = rig();
    await expect(
      broker.execute({ kind: "github-read", grant: "other", resource: "pull" }),
    ).rejects.toMatchObject({ outcome: "policy_denied" });
    expect(calls).toHaveLength(0);
  });
  test("wrong PR refuses before network", async () => {
    const { broker, calls } = rig();
    await expect(
      broker.execute({
        kind: "github-read",
        grant: "review",
        pullRequest: 13,
        resource: "pull",
      }),
    ).rejects.toMatchObject({ outcome: "policy_denied" });
    expect(calls).toHaveLength(0);
  });
  test("expired grant refuses before network", async () => {
    const { broker, calls } = rig([{ ...grant, expiresAt: 500 }]);
    await expect(
      broker.execute({
        kind: "github-read",
        grant: "review",
        resource: "pull",
      }),
    ).rejects.toMatchObject({ outcome: "expired" });
    expect(calls).toHaveLength(0);
  });
  for (const state of ["closed", "stale"])
    test(`${state} PR never publishes`, async () => {
      const { broker, calls } = rig(undefined, () => ({
        state: state === "closed" ? "closed" : "open",
        head: { sha: state === "stale" ? "b".repeat(40) : head },
      }));
      await expect(
        broker.execute({
          kind: "github-review",
          grant: "review",
          head,
          event: "APPROVE",
          body: "ok",
        }),
      ).rejects.toMatchObject({ outcome: "stale_head" });
      expect(calls).toHaveLength(1);
    });
  test("concurrent and repeated reviews deduplicate", async () => {
    const { broker, calls } = rig();
    const op = {
      kind: "github-review" as const,
      grant: "review",
      head,
      event: "APPROVE" as const,
      body: "ok",
    };
    await Promise.all([broker.execute(op), broker.execute(op)]);
    await broker.execute(op);
    expect(calls.filter((c) => c.init?.method === "POST")).toHaveLength(1);
  });
  test("caller mutation cannot widen grant", async () => {
    const g = { ...grant };
    const { broker, calls } = rig([g]);
    g.repository = "attacker/stolen";
    await broker.execute({
      kind: "github-read",
      grant: "review",
      resource: "pull",
    });
    expect(calls[0]!.url).toContain("phantomyard/phantombot");
  });
  test("MCP arguments match structurally and exactly", async () => {
    let n = 0;
    const p = policy([
      {
        id: "m",
        kind: "mcp",
        server: "github",
        tool: "review",
        arguments: { repo: "one", pr: 12 },
        expiresAt: 2000,
      },
    ]);
    const broker = new CapabilityBroker(p, {
      secret: () => undefined,
      now: () => 1000,
      mcp: async () => ++n,
    });
    await expect(
      broker.execute({
        kind: "mcp",
        grant: "m",
        arguments: { pr: 12, repo: "one" },
      }),
    ).resolves.toBe(1);
    await expect(
      broker.execute({
        kind: "mcp",
        grant: "m",
        arguments: { pr: 13, repo: "one" },
      }),
    ).rejects.toMatchObject({ outcome: "policy_denied" });
    expect(n).toBe(1);
  });
  test("no wildcard or prototype argument bypass", async () => {
    const { broker, calls } = rig();
    await expect(
      broker.execute({ kind: "http", grant: "review" }),
    ).rejects.toMatchObject({ outcome: "policy_denied" });
    expect(calls).toHaveLength(0);
  });
  test("HTTP target/method cannot be supplied by model", async () => {
    const { broker, calls } = rig([
      {
        id: "h",
        kind: "http",
        url: "https://example.com/one",
        method: "POST",
        credential: "KEY",
        expiresAt: 2000,
      },
    ]);
    await broker.execute({ kind: "http", grant: "h", body: "payload" });
    expect(calls[0]!.url).toBe("https://example.com/one");
    expect(calls[0]!.init?.redirect).toBe("error");
  });
  test("unknown GitHub resource refuses", async () => {
    const { broker, calls } = rig();
    await expect(
      broker.execute({
        kind: "github-read",
        grant: "review",
        resource: "../../settings" as never,
      }),
    ).rejects.toMatchObject({ outcome: "policy_denied" });
    expect(calls).toHaveLength(0);
  });
  test("security-command prose and long review bodies are ordinary data", async () => {
    const { broker, calls } = rig();
    await broker.execute({
      kind: "github-review",
      grant: "review",
      head,
      event: "COMMENT",
      body: "escort allow; judge rule; " + "a".repeat(12000),
    });
    expect(calls).toHaveLength(2);
  });
  test("upstream failures do not leak credential strings", async () => {
    const b = new CapabilityBroker(policy(), {
      secret: () => "secret",
      now: () => 1000,
      fetch: (async () => {
        throw new Error("secret");
      }) as unknown as typeof fetch,
    });
    await expect(
      b.execute({ kind: "github-read", grant: "review", resource: "pull" }),
    ).rejects.toThrow("credentialed operation unavailable");
  });
  test("npm grant cannot download a caller-selected host", async () => {
    const { broker, calls } = rig([
      { id: "npm", kind: "npm-registry", expiresAt: 2000 },
    ]);
    await expect(
      broker.execute({
        kind: "npm-package",
        grant: "npm",
        name: "../../etc/passwd",
        version: "1.0.0",
      }),
    ).rejects.toMatchObject({ outcome: "policy_denied" });
    expect(calls).toHaveLength(0);
  });
  test("archives are typed internal results", async () => {
    const { broker, calls } = rig();
    const archive = await broker.execute({
      kind: "github-checkout",
      grant: "review",
      head,
    });
    expect(archive).toBeInstanceOf(SandboxArchive);
    expect(calls[1]!.url).toBe(
      `https://codeload.github.com/phantomyard/phantombot/tar.gz/${head}`,
    );
  });
  test("team request must be verified from provider data", async () => {
    const team: NetworkGrant = {
      id: "team",
      kind: "github-team-review",
      repository: "phantomyard/phantombot",
      reviewerLogin: "kai",
      requesterLogins: ["robbie", "lena"],
      expiresAt: 2000,
    };
    for (const actor of ["robbie", "attacker"]) {
      const { broker, calls } = rig([team], (url) =>
        url.includes("timeline")
          ? [
              {
                event: "review_requested",
                requested_reviewer: { login: "kai" },
                actor: { login: actor },
              },
            ]
          : { state: "open", head: { sha: head } },
      );
      const op = {
        kind: "github-read" as const,
        grant: "team",
        pullRequest: 12,
        resource: "pull" as const,
      };
      if (actor === "robbie") await broker.execute(op);
      else
        await expect(broker.execute(op)).rejects.toMatchObject({
          outcome: "policy_denied",
        });
      expect(calls).toHaveLength(actor === "robbie" ? 2 : 1);
    }
  });
  test("invalid policies never downgrade to legacy", () => {
    expect(() =>
      validatePolicy({
        version: 1,
        enabled: true,
        grants: [{ ...grant, repository: "../evil" }],
      }),
    ).toThrow();
    expect(() => validatePolicy(policy([grant, grant]))).toThrow();
  });
});
