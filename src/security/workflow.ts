/**
 * GHSA-w7w8: the unattended-work half of the credential broker. A bounded
 * turn (no vault, no host files, no network) still has to do a full PR loop
 * and talk to its owner, so these operations run HERE, in the runtime, with
 * the persona's credentials — and the model only ever sees results.
 *
 * Every write is narrow by construction: GitHub writes are an allowlist of PR,
 * review, comment, re-run and label endpoints (never merge, never the default
 * branch, never repo settings); host git never runs inside a sandbox-written
 * repository (the sandbox makes a bundle, the host fetches it into a fresh
 * bare repo it owns); host commands are exact owner grants.
 */
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { randomBytes } from "node:crypto";
import type { NetworkGrant, WorkflowOperation } from "./types.ts";
import { PolicyError, SandboxArchive } from "./broker.ts";
import type { EscortAllowKind } from "../lib/escort.ts";

export interface HostRun {
  code: number;
  stdout: Uint8Array;
  stderr: string;
}
export interface WorkflowDeps {
  workspace: string;
  /** Run argv on the host (never through a shell). */
  host(argv: string[], opts: { env?: Record<string, string>; stdin?: Uint8Array; timeoutMs: number }): Promise<HostRun>;
  /** Run a shell command inside this session's sandbox. */
  sandbox(command: string): Promise<{ exitCode: number; output: string }>;
  /** This phantombot, as argv (bun <entry> from source). */
  self: string[];
  persona: string;
  /** The persona's env with its vault applied, for host commands. */
  personaEnv(): Promise<Record<string, string>>;
  secret(name: string): Promise<string | undefined> | string | undefined;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

type WorkflowGrant = Extract<NetworkGrant, { kind: "github" | "notify" | "memory" | "host-command" }>;
export const WORKFLOW_GRANT_KINDS = new Set(["github", "notify", "memory", "host-command"]);
export const WORKFLOW_OPERATION_KINDS = new Set([
  "github-clone", "github-push", "github-api", "notify", "memory-capture", "memory-search", "host-command",
]);

const REPO = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const REL_DIR = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const BRANCH = /^[A-Za-z0-9._\/-]{1,200}$/;
const SHA = /^[a-f0-9]{40}$/;
const MEMORY_TAGS = new Set(["decision", "lesson", "person", "commitment", "norm"]);

/** GitHub REST writes a bounded turn may make, relative to /repos/<repo>. */
const GITHUB_WRITES: Array<[string, RegExp, EscortAllowKind]> = [
  ["POST", /^\/pulls$/, "github"],
  ["PATCH", /^\/pulls\/\d+$/, "github"],
  ["POST", /^\/pulls\/\d+\/reviews$/, "review"],
  ["POST", /^\/pulls\/\d+\/reviews\/\d+\/events$/, "review"],
  ["POST", /^\/pulls\/\d+\/comments$/, "comment"],
  ["POST", /^\/pulls\/\d+\/comments\/\d+\/replies$/, "comment"],
  ["PATCH", /^\/pulls\/comments\/\d+$/, "comment"],
  ["POST", /^\/pulls\/\d+\/requested_reviewers$/, "github"],
  ["DELETE", /^\/pulls\/\d+\/requested_reviewers$/, "github"],
  ["POST", /^\/issues\/\d+\/comments$/, "comment"],
  ["PATCH", /^\/issues\/comments\/\d+$/, "comment"],
  ["POST", /^\/issues\/\d+\/labels$/, "github"],
  ["POST", /^\/actions\/runs\/\d+\/(?:rerun|rerun-failed-jobs)$/, "github"],
  ["POST", /^\/actions\/jobs\/\d+\/rerun$/, "github"],
];
/** PATCH /pulls/N may edit only these fields (no base change, no state). */
const PULL_PATCH_FIELDS = new Set(["title", "body"]);
/** GraphQL mutations a bounded turn may run (all take `input:`). */
const GRAPHQL_MUTATIONS: Record<string, EscortAllowKind> = {
  resolveReviewThread: "review",
  unresolveReviewThread: "review",
  addPullRequestReview: "review",
  submitPullRequestReview: "review",
  addPullRequestReviewThreadReply: "comment",
  addPullRequestReviewComment: "comment",
  addComment: "comment",
  requestReviews: "github",
  markPullRequestReadyForReview: "github",
};

function deny(message: string): never {
  throw new PolicyError("policy_denied", message);
}

/** Resolve a workspace-relative path; anything escaping the workspace is refused. */
export function insideWorkspace(workspace: string, relative: string): string {
  if (!REL_DIR.test(relative) || relative.split("/").some((p) => p === ".." || p === "."))
    deny("invalid workspace path");
  const root = realpathSync(workspace);
  const full = realpathSync(join(root, relative));
  if (full !== root && !full.startsWith(root + sep)) deny("path escapes the workspace");
  return full;
}

function repositoryFor(grant: Extract<WorkflowGrant, { kind: "github" }>, requested: unknown): string {
  if (grant.repository === "*") {
    if (typeof requested !== "string" || !REPO.test(requested)) deny("repository required");
    return requested;
  }
  if (requested !== undefined && requested !== grant.repository) deny("repository outside grant");
  return grant.repository;
}

/**
 * Every field called with arguments in a GraphQL MUTATION document, or null
 * for a read-only document. String literals are removed first (their text is
 * never code), then comments are refused outright and commas/BOM — GraphQL
 * "ignored tokens" — become spaces, so nothing can hide a call such as
 * `mergePullRequest` between allowed ones. Operation headers (name and
 * variable definitions) are dropped; any OTHER `name(` must be an allowed
 * mutation, so a mutation's response selection takes no arguments. Errs
 * closed: anything unusual is a field the allowlist does not know.
 */
export function graphqlMutationFields(query: string): string[] | null {
  let q = query.replace(/"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"/g, '""');
  if (q.replace(/""/g, "").includes('"')) deny("invalid GraphQL string");
  if (q.includes("#")) deny("GraphQL comments are not accepted");
  q = q.replace(/[,\uFEFF]/g, " ");
  if (!/\bmutation\b/.test(q)) return null;
  q = q.replace(/\b(?:query|mutation|subscription)\b\s*(?:[A-Za-z_][A-Za-z0-9_]*)?\s*(?:\([^)]*\))?/g, " ");
  return [...q.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1]!);
}

/** Split a github-api path into repo-relative path + query; null = graphql. */
export function classifyGithubApi(
  op: Extract<WorkflowOperation, { kind: "github-api" }>,
  repository: string,
  anyRepository: boolean,
): { url: string; kind: EscortAllowKind | undefined } {
  if (typeof op.path !== "string" || op.path.length > 2048 || /\.\.|\/\/|#|\s|\\/.test(op.path))
    deny("invalid GitHub path");
  if (!["GET", "POST", "PATCH", "PUT", "DELETE"].includes(op.method)) deny("invalid method");
  if (op.path === "/graphql") {
    if (op.method !== "POST") deny("GraphQL is POST");
    const body = op.body as { query?: unknown } | undefined;
    if (!body || typeof body !== "object" || typeof body.query !== "string") deny("GraphQL query required");
    const fields = graphqlMutationFields(body.query);
    if (fields === null) return { url: "https://api.github.com/graphql", kind: undefined };
    if (!anyRepository) deny("GraphQL mutations need an any-repository grant");
    if (!fields.length || fields.some((f) => !Object.hasOwn(GRAPHQL_MUTATIONS, f)))
      deny("GraphQL mutation outside grant");
    const kinds = fields.map((f) => GRAPHQL_MUTATIONS[f]!);
    const kind = kinds.includes("github") ? "github" : kinds.includes("comment") ? "comment" : "review";
    return { url: "https://api.github.com/graphql", kind };
  }
  const prefix = `/repos/${repository}`;
  if (op.path !== prefix && !op.path.startsWith(prefix + "/") && !op.path.startsWith(prefix + "?"))
    deny("path outside the repository");
  const rest = op.path.slice(prefix.length);
  const [route, query = ""] = rest.split("?", 2) as [string, string?];
  if (query && !/^[A-Za-z0-9_=&.,:%+-]*$/.test(query)) deny("invalid query");
  const url = `https://api.github.com${op.path}`;
  if (op.method === "GET") {
    if (op.body !== undefined) deny("GET has no body");
    return { url, kind: undefined };
  }
  const match = GITHUB_WRITES.find(([m, re]) => m === op.method && re.test(route));
  if (!match) deny("GitHub write outside grant (merge, settings and default-branch writes are never brokered)");
  if (op.method === "PATCH" && /^\/pulls\/\d+$/.test(route)) {
    const b = op.body as Record<string, unknown> | undefined;
    if (!b || typeof b !== "object" || Object.keys(b).some((k) => !PULL_PATCH_FIELDS.has(k)))
      deny("only title and body of a pull request may be edited");
  }
  return { url, kind: match[2] };
}

/**
 * The escort kind of a workflow operation; undefined = never judged.
 *
 * The PR loop (clone, push a non-default branch, PR/review/comment/thread/
 * re-run/label API) and notifying the owner are NOT judged: the allowlist
 * above is their gate (no merge, no default branch, no settings, notify only
 * reaches the owner), and unattended PR work must never stop on a hold. Only
 * a memory write (it outlives the turn) and an owner-granted host command
 * (it runs outside the sandbox) meet the escort.
 */
export function workflowEscortKind(op: WorkflowOperation): EscortAllowKind | undefined {
  switch (op.kind) {
    case "memory-capture":
      return "memory";
    case "host-command":
      return "shell";
    default:
      return undefined;
  }
}

export class WorkflowBroker {
  constructor(private readonly deps: WorkflowDeps) {}

  private async githubToken(grant: Extract<WorkflowGrant, { kind: "github" }>): Promise<string> {
    for (const name of grant.credential ? [grant.credential] : ["GITHUB_TOKEN", "GH_TOKEN"]) {
      const v = await this.deps.secret(name);
      if (v) return v;
    }
    if (!grant.credential) {
      // The persona's existing `gh auth login`, so no new setup is needed.
      const r = await this.deps.host(["gh", "auth", "token"], { env: await this.deps.personaEnv(), timeoutMs: 10_000 }).catch(() => undefined);
      const t = r && r.code === 0 ? new TextDecoder().decode(r.stdout).trim() : "";
      if (/^[A-Za-z0-9_]{20,255}$/.test(t)) return t;
    }
    throw new PolicyError("unavailable", "GitHub credential unavailable");
  }

  private gitAuth(token: string): string[] {
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    return [
      "-c", `http.https://github.com/.extraHeader=Authorization: Basic ${basic}`,
      "-c", "core.hooksPath=/dev/null",
      "-c", "protocol.file.allow=never",
      "-c", "credential.helper=",
    ];
  }

  private async git(args: string[], opts: { timeoutMs?: number } = {}): Promise<HostRun> {
    const r = await this.deps.host(["git", ...args], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmpdir(), GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LANG: "C.UTF-8" },
      timeoutMs: opts.timeoutMs ?? 300_000,
    });
    // stderr can echo URLs; never surface it. A fixed category only.
    if (r.code !== 0) throw new PolicyError("unavailable", "git operation failed");
    return r;
  }

  private async api(token: string, url: string, init: { method: string; body?: unknown }): Promise<unknown> {
    const signal = this.deps.signal ? AbortSignal.any([this.deps.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "phantombot",
    };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const f = this.deps.fetch ?? fetch;
    let r = await f(url, { method: init.method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), redirect: "manual", signal });
    if (r.status >= 300 && r.status < 400 && init.method === "GET") {
      // CI logs redirect to a short-lived signed URL: follow once, WITHOUT the token.
      const location = r.headers.get("location");
      if (!location || !/^https:\/\/[a-z0-9.-]+\.(?:githubusercontent|blob\.core\.windows)\.(?:com|net)\//.test(location))
        throw new PolicyError("unavailable", "unexpected redirect");
      r = await f(location, { redirect: "error", signal });
    }
    const text = await r.text();
    if (text.length > 8 * 1024 * 1024) throw new PolicyError("payload_limit", "response exceeds 8 MiB");
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* text */ }
    if (!r.ok) return { status: r.status, error: typeof body === "object" ? (body as { message?: unknown }).message ?? body : String(body).slice(0, 2000) };
    return body;
  }

  async execute(grant: NetworkGrant, op: WorkflowOperation): Promise<unknown> {
    if (grant.kind === "github" && op.kind.startsWith("github-")) return this.github(grant, op);
    if (grant.kind === "notify" && op.kind === "notify") {
      if (typeof op.message !== "string" || !op.message.trim() || op.message.length > 4000) deny("invalid message");
      const r = await this.deps.host([...this.deps.self, "notify", "--persona", this.deps.persona, "--message", op.message], { env: await this.deps.personaEnv(), timeoutMs: 25_000 });
      if (r.code !== 0) throw new PolicyError("unavailable", "notify failed");
      return { sent: true };
    }
    if (grant.kind === "memory" && (op.kind === "memory-capture" || op.kind === "memory-search")) {
      if (op.kind === "memory-search") {
        if (typeof op.query !== "string" || !op.query.trim() || op.query.length > 1000) deny("invalid query");
        const limit = Number.isSafeInteger(op.limit) && op.limit! > 0 && op.limit! <= 20 ? op.limit! : 8;
        const r = await this.deps.host([...this.deps.self, "memory", "search", op.query, "--persona", this.deps.persona, "--limit", String(limit)], { env: await this.deps.personaEnv(), timeoutMs: 60_000 });
        if (r.code !== 0) throw new PolicyError("unavailable", "memory search failed");
        return new TextDecoder().decode(r.stdout).slice(0, 256 * 1024);
      }
      const tags = op.tags ?? [];
      if (typeof op.text !== "string" || !op.text.trim() || op.text.length > 4000 || !Array.isArray(tags) || !tags.length || tags.some((t) => !MEMORY_TAGS.has(t)))
        deny("invalid capture (text plus at least one tag: decision|lesson|person|commitment|norm)");
      const r = await this.deps.host([...this.deps.self, "memory", "capture", op.text, "--persona", this.deps.persona, ...tags.flatMap((t) => ["--tag", t])], { env: await this.deps.personaEnv(), timeoutMs: 60_000 });
      if (r.code !== 0) throw new PolicyError("unavailable", "memory capture failed");
      return { captured: true };
    }
    if (grant.kind === "host-command" && op.kind === "host-command") {
      const extra = op.args ?? [];
      if (!Array.isArray(extra) || extra.some((a) => typeof a !== "string" || a.length > 4096 || a.includes("\0"))) deny("invalid arguments");
      if (extra.length && grant.extraArgs !== true) deny("this command takes no extra arguments");
      const r = await this.deps.host([...grant.command, ...extra], { env: await this.deps.personaEnv(), timeoutMs: 300_000 });
      const out = new TextDecoder().decode(r.stdout);
      return { exitCode: r.code, stdout: out.slice(0, 1024 * 1024), stderr: r.stderr.slice(0, 64 * 1024) };
    }
    deny("operation exceeds grant");
  }

  private async github(grant: Extract<WorkflowGrant, { kind: "github" }>, op: WorkflowOperation): Promise<unknown> {
    if (op.kind === "github-api") {
      const inferred = op.repository ?? (grant.repository === "*" && op.path !== "/graphql" && typeof op.path === "string" ? op.path.split("/").slice(2, 4).join("/") : undefined);
      const repository = op.path === "/graphql" && grant.repository === "*" ? "*" : repositoryFor(grant, inferred);
      const { url } = classifyGithubApi(op, repository, grant.repository === "*");
      return this.api(await this.githubToken(grant), url, { method: op.method, body: op.body });
    }
    if (op.kind === "github-clone") {
      const repository = repositoryFor(grant, op.repository);
      if (op.ref !== undefined && (typeof op.ref !== "string" || !(SHA.test(op.ref) || (BRANCH.test(op.ref) && !op.ref.includes("..") && !op.ref.startsWith("-")))))
        deny("invalid ref");
      const directory = op.directory ?? repository.split("/")[1]!;
      if (!REL_DIR.test(directory) || directory.split("/").some((p) => p === ".." || p === ".")) deny("invalid directory");
      const token = await this.githubToken(grant);
      const tmp = mkdtempSync(join(tmpdir(), "pb-clone-"));
      try {
        const dest = join(tmp, "repo");
        await this.git([...this.gitAuth(token), "clone", "--no-recurse-submodules", "--quiet", ...(op.ref && !SHA.test(op.ref) ? ["--branch", op.ref] : []), "--", `https://github.com/${repository}.git`, dest]);
        if (op.ref && SHA.test(op.ref)) {
          await this.git(["-C", dest, ...this.gitAuth(token), "fetch", "--quiet", "origin", op.ref]);
          await this.git(["-C", dest, "-c", "core.hooksPath=/dev/null", "checkout", "--quiet", "--detach", op.ref]);
        }
        const tar = await this.deps.host(["tar", "-czf", "-", "-C", tmp, "repo"], { timeoutMs: 120_000 });
        if (tar.code !== 0) throw new PolicyError("unavailable", "archive failed");
        if (tar.stdout.length > 256 * 1024 * 1024) throw new PolicyError("payload_limit", "repository exceeds 256 MiB");
        return new SandboxArchive(directory, tar.stdout);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
    if (op.kind === "github-push") {
      const repository = repositoryFor(grant, op.repository);
      if (typeof op.branch !== "string" || !BRANCH.test(op.branch) || op.branch.includes("..") || op.branch.startsWith("-") || op.branch.startsWith("/") || op.branch.endsWith("/") || op.branch.endsWith(".lock"))
        deny("invalid branch");
      if (typeof op.sha !== "string" || !SHA.test(op.sha)) deny("invalid sha");
      const token = await this.githubToken(grant);
      const meta = (await this.api(token, `https://api.github.com/repos/${repository}`, { method: "GET" })) as { default_branch?: string };
      if (typeof meta?.default_branch !== "string") throw new PolicyError("unavailable", "repository unavailable");
      if (op.branch === meta.default_branch) deny("pushing to the default branch is never brokered; open a pull request");
      if (process.platform === "win32") throw new PolicyError("unavailable", "push is not available from the Windows sandbox yet");
      const root = realpathSync(this.deps.workspace);
      if (insideWorkspace(root, op.directory) === root) deny("push from a checkout directory, not the workspace root");
      const name = `.pb-push-${randomBytes(6).toString("hex")}.bundle`;
      // The bundle is made INSIDE the sandbox (cwd = workspace root): host git
      // never reads a sandbox-written repository's config or hooks.
      const rel = op.directory;
      const made = await this.deps.sandbox(
        `git -C '${rel}' update-ref refs/pb/push ${op.sha} && git -C '${rel}' bundle create "$(pwd)/${name}" refs/pb/push >/dev/null 2>&1; s=$?; git -C '${rel}' update-ref -d refs/pb/push 2>/dev/null; exit $s`,
      );
      if (made.exitCode !== 0) deny("could not bundle that commit (is it committed in that checkout?)");
      const bundle = join(root, name);
      try {
        const st = lstatSync(bundle);
        if (!st.isFile() || st.size > 256 * 1024 * 1024) deny("bundle too large");
        const bare = mkdtempSync(join(tmpdir(), "pb-push-"));
        try {
          await this.git(["init", "--bare", "--quiet", bare]);
          await this.git(["-C", bare, "-c", "core.hooksPath=/dev/null", "fetch", "--quiet", bundle, `refs/pb/push:refs/pb/push`]);
          const head = new TextDecoder().decode((await this.git(["-C", bare, "rev-parse", "refs/pb/push"])).stdout).trim();
          if (head !== op.sha) deny("bundle does not carry that commit");
          await this.git(["-C", bare, ...this.gitAuth(token), "push", "--quiet", `https://github.com/${repository}.git`, `${op.force ? "+" : ""}refs/pb/push:refs/heads/${op.branch}`]);
          return { pushed: true, repository, branch: op.branch, sha: op.sha };
        } finally {
          rmSync(bare, { recursive: true, force: true });
        }
      } finally {
        rmSync(bundle, { force: true });
      }
    }
    deny("operation exceeds grant");
  }
}
