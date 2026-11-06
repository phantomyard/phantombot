/** Credentials and grant authority stay in the runtime, outside model tools. */
import type {
  BrokerOperation,
  NetworkGrant,
  SecurityAudit,
  SecurityOutcome,
  SecurityPolicy,
} from "./types.ts";
import { sameJson, validatePolicy } from "./policy.ts";
import type { WorkflowBroker } from "./workflow.ts";

export class SandboxArchive {
  constructor(
    readonly directory: string,
    readonly bytes: Uint8Array,
  ) {}
}

export class PolicyError extends Error {
  constructor(
    readonly outcome: SecurityOutcome,
    message: string,
  ) {
    super(message);
  }
}
export class CapabilityBroker {
  private readonly grants: Map<string, NetworkGrant>;
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly published = new Map<string, unknown>();
  constructor(
    policy: SecurityPolicy,
    private readonly deps: {
      secret(name: string): string | undefined;
      fetch?: typeof fetch;
      mcp?: (
        server: string,
        tool: string,
        args: Record<string, unknown>,
      ) => Promise<unknown>;
      audit?: (event: SecurityAudit) => void;
      now?: () => number;
      signal?: AbortSignal;
      /** Workflow grants (github, notify, memory, host-command). */
      workflow?: WorkflowBroker;
      /**
       * The escort, judging ONLY actions that leave the sandbox (GHSA-w7w8).
       * Throws a PolicyError to refuse. Absent = grants alone decide.
       */
      gate?: (grant: NetworkGrant, operation: BrokerOperation) => Promise<void>;
    },
  ) {
    this.grants = new Map(validatePolicy(policy).grants.map((g) => [g.id, g]));
  }
  private async request(url: string, init: RequestInit = {}): Promise<unknown> {
    const signal = this.deps.signal
      ? AbortSignal.any([this.deps.signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000);
    const r = await (this.deps.fetch ?? fetch)(url, {
      ...init,
      redirect: "error",
      signal,
    });
    if (!r.ok)
      throw new PolicyError("unavailable", `upstream HTTP ${r.status}`);
    if (!r.body) return null;
    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 8 * 1024 * 1024)
          throw new PolicyError("payload_limit", "response exceeds 8 MiB");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const text = Buffer.concat(chunks).toString("utf8");
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  private async archive(
    url: string,
    headers?: Record<string, string>,
  ): Promise<Uint8Array> {
    const signal = this.deps.signal
      ? AbortSignal.any([this.deps.signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000);
    const response = await (this.deps.fetch ?? fetch)(url, {
      headers,
      redirect: "error",
      signal,
    });
    if (!response.ok || !response.body)
      throw new PolicyError("unavailable", "archive unavailable");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 64 * 1024 * 1024)
          throw new PolicyError("payload_limit", "archive exceeds 64 MiB");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks);
  }
  async execute(operation: BrokerOperation): Promise<unknown> {
    const started = performance.now();
    let outcome: SecurityOutcome = "allowed";
    try {
      if (
        !operation ||
        typeof operation !== "object" ||
        typeof operation.grant !== "string"
      )
        throw new PolicyError("policy_denied", "a grant is required");
      if (Buffer.byteLength(JSON.stringify(operation)) > 1024 * 1024)
        throw new PolicyError("payload_limit", "operation exceeds 1 MiB");
      const grant = this.grants.get(operation.grant);
      if (!grant) throw new PolicyError("policy_denied", "no such grant");
      if (grant.expiresAt <= (this.deps.now ?? Date.now)())
        throw new PolicyError("expired", "grant expired");
      await this.deps.gate?.(grant, operation);
      if (
        grant.kind === "github" ||
        grant.kind === "notify" ||
        grant.kind === "memory" ||
        grant.kind === "host-command"
      ) {
        if (!this.deps.workflow)
          throw new PolicyError("unavailable", "workflow operations unavailable");
        return await this.deps.workflow.execute(grant, operation as never);
      }
      if (grant.kind === "npm-registry" && operation.kind === "npm-package") {
        if (
          !/^(?:@[a-z0-9_-]+\/)?[a-z0-9_-][a-z0-9._-]*$/.test(operation.name) ||
          !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.+_-]+)?$/.test(
            operation.version,
          )
        )
          throw new PolicyError("policy_denied", "invalid npm package");
        const basename = operation.name.split("/").at(-1)!;
        const bytes = await this.archive(
          `https://registry.npmjs.org/${operation.name}/-/${basename}-${operation.version}.tgz`,
        );
        return new SandboxArchive(
          `.bun/install/cache/${operation.name}@${operation.version}@@@1`,
          bytes,
        );
      }
      if (grant.kind === "http" && operation.kind === "http") {
        const secret = grant.credential
          ? this.deps.secret(grant.credential)
          : undefined;
        if (grant.credential && !secret)
          throw new PolicyError("unavailable", "grant credential unavailable");
        return await this.request(grant.url, {
          method: grant.method,
          ...(operation.body === undefined ? {} : { body: operation.body }),
          headers: secret ? { Authorization: `Bearer ${secret}` } : {},
        });
      }
      if (grant.kind === "mcp" && operation.kind === "mcp") {
        if (!sameJson(grant.arguments, operation.arguments))
          throw new PolicyError("policy_denied", "MCP arguments exceed grant");
        if (!this.deps.mcp)
          throw new PolicyError("unavailable", "MCP unavailable");
        return await this.deps.mcp(
          grant.server,
          grant.tool,
          operation.arguments,
        );
      }
      if (
        !["github-review", "github-team-review"].includes(grant.kind) ||
        !["github-read", "github-review", "github-checkout"].includes(
          operation.kind,
        )
      )
        throw new PolicyError("policy_denied", "operation exceeds grant");
      if (
        (grant.kind !== "github-review" &&
          grant.kind !== "github-team-review") ||
        (operation.kind !== "github-read" &&
          operation.kind !== "github-review" &&
          operation.kind !== "github-checkout")
      )
        throw new PolicyError("policy_denied", "wrong operation");
      const pullRequest =
        grant.kind === "github-review"
          ? grant.pullRequest
          : operation.pullRequest;
      if (
        !Number.isSafeInteger(pullRequest) ||
        !pullRequest ||
        pullRequest < 1 ||
        (grant.kind === "github-review" &&
          operation.pullRequest !== undefined &&
          operation.pullRequest !== grant.pullRequest)
      )
        throw new PolicyError("policy_denied", "wrong PR");
      const token = this.deps.secret("GITHUB_TOKEN");
      if (!token)
        throw new PolicyError("unavailable", "GitHub credential unavailable");
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      };
      const root = `https://api.github.com/repos/${grant.repository}/pulls/${pullRequest}`;
      const verifyTeamRequest = async () => {
        if (grant.kind !== "github-team-review") return;
        let authorized = false;
        // Timeline pages are chronological. A removal or a replacement request
        // from an untrusted actor revokes the earlier authority.
        for (let page = 1; page <= 20; page++) {
          const events = (await this.request(
            `https://api.github.com/repos/${grant.repository}/issues/${pullRequest}/timeline?per_page=100&page=${page}`,
            { headers },
          )) as {
            event?: string;
            actor?: { login?: string };
            requested_reviewer?: { login?: string };
          }[];
          if (!Array.isArray(events))
            throw new PolicyError("policy_denied", "invalid review timeline");
          for (const event of events) {
            if (event.requested_reviewer?.login?.toLowerCase() !==
                grant.reviewerLogin.toLowerCase()) continue;
            if (event.event === "review_request_removed") authorized = false;
            else if (event.event === "review_requested")
              authorized = grant.requesterLogins.some(
                login => login.toLowerCase() === event.actor?.login?.toLowerCase(),
              );
          }
          if (events.length < 100) {
            if (!authorized)
              throw new PolicyError("policy_denied", "no verified team review request");
            return;
          }
        }
        throw new PolicyError("policy_denied", "review timeline exceeds verification limit");
      };
      await verifyTeamRequest();
      if (operation.kind === "github-checkout") {
        if (!/^[a-f0-9]{40}$/.test(operation.head))
          throw new PolicyError("policy_denied", "invalid head");
        const pull = (await this.request(root, { headers })) as {
          state?: string;
          head?: { sha?: string };
        };
        if (pull.state !== "open" || pull.head?.sha !== operation.head)
          throw new PolicyError("stale_head", "PR head changed");
        return new SandboxArchive(
          "repository",
          await this.archive(
            `https://codeload.github.com/${grant.repository}/tar.gz/${operation.head}`,
            headers,
          ),
        );
      }
      if (operation.kind === "github-read") {
        if (
          !["pull", "files", "comments", "reviews"].includes(operation.resource)
        )
          throw new PolicyError("policy_denied", "unknown review resource");
        return await this.request(
          root +
            (operation.resource === "pull"
              ? ""
              : `/${operation.resource}?per_page=100`),
          { headers },
        );
      }
      if (
        operation.kind !== "github-review" ||
        !/^[a-f0-9]{40}$/.test(operation.head) ||
        !["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(operation.event) ||
        typeof operation.body !== "string"
      )
        throw new PolicyError("policy_denied", "invalid review");
      if (
        operation.comments &&
        (!Array.isArray(operation.comments) ||
          operation.comments.some(
            (c) =>
              !c ||
              typeof c.path !== "string" ||
              !Number.isSafeInteger(c.line) ||
              c.line < 1 ||
              !["LEFT", "RIGHT"].includes(c.side) ||
              typeof c.body !== "string",
          ))
      )
        throw new PolicyError("policy_denied", "invalid inline comments");
      const review = {
        commit_id: operation.head,
        event: operation.event,
        body: operation.body,
        ...(operation.comments ? { comments: operation.comments } : {}),
      };
      const key = JSON.stringify([grant.id, review]);
      const existing = this.pending.get(key);
      if (existing) return await existing;
      if (this.published.has(key)) return this.published.get(key);
      const send = async () => {
        const pull = (await this.request(root, { headers })) as {
          state?: string;
          head?: { sha?: string };
        };
        if (pull.state !== "open" || pull.head?.sha !== operation.head)
          throw new PolicyError(
            "stale_head",
            "PR closed or head changed; re-review the current head",
          );
        await verifyTeamRequest();
        // Recheck expiry immediately before the write, after the network read.
        if (grant.expiresAt <= (this.deps.now ?? Date.now)())
          throw new PolicyError("expired", "grant expired");
        const result = await this.request(`${root}/reviews`, {
          method: "POST",
          headers,
          body: JSON.stringify(review),
        });
        this.published.set(key, result);
        return result;
      };
      const pending = send();
      this.pending.set(key, pending);
      try {
        return await pending;
      } finally {
        this.pending.delete(key);
      }
    } catch (error) {
      outcome = error instanceof PolicyError ? error.outcome : "unavailable";
      if (error instanceof PolicyError) throw error;
      // Upstream errors can contain credentials; expose only a fixed category.
      throw new PolicyError(
        "unavailable",
        "credentialed operation unavailable",
      );
    } finally {
      try {
        this.deps.audit?.({
          operation:
            typeof operation?.kind === "string" ? operation.kind : "invalid",
          ...(typeof operation?.grant === "string"
            ? { grant: operation.grant }
            : {}),
          outcome,
          durationMs: Math.round(performance.now() - started),
        });
      } catch {
        /* audit never changes authority */
      }
    }
  }
}
