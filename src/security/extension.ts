import { Type } from "typebox";
import { ENV_SECURITY_SESSION } from "./session.ts";
import type { SessionDescriptor } from "./types.ts";

interface SessionTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}
export interface SecurityExtensionApi {
  registerTool(tool: SessionTool): void;
  on(
    event: "tool_call",
    handler: (event: { toolName: string; input: unknown }) => unknown,
  ): void;
}
/** Parse the runtime-issued session descriptor; anything malformed = none. */
export function sessionFromEnv(env: NodeJS.ProcessEnv = process.env): SessionDescriptor | undefined {
  const raw = env[ENV_SECURITY_SESSION];
  if (raw === undefined) return undefined;
  try {
    const s = JSON.parse(raw) as SessionDescriptor;
    const u = new URL(s.url);
    if (
      u.protocol === "http:" &&
      u.hostname === "127.0.0.1" &&
      u.pathname === "/operation" &&
      /^[a-f0-9]{64}$/.test(s.token)
    )
      return s;
  } catch {
    /* treated as no session */
  }
  return undefined;
}

export const SANDBOX_TOOL_DESCRIPTION =
  "Run shell commands in the disposable workspace. No credentials, host files or direct network. Reads, edits, installs from cached dependencies, tests and cleanup are permitted without further model checks.";
export const BROKER_TOOL_DESCRIPTION =
  "Do what the sandbox cannot (network, credentials) under the owner's grants. {manifest:true} lists grants. Otherwise operation:{kind,grant,...}. " +
  "GitHub (grant kind github): github-clone {repository:'owner/name',ref?,directory?} copies a checkout into the workspace; " +
  "github-push {repository,directory,branch,sha,force?} pushes a COMMITTED sha from that checkout to a non-default branch; " +
  "github-api {method,path:'/repos/owner/name/...' or '/graphql',body?} = any GET/GraphQL query, plus PR create/edit (title, body), reviews, review comments/replies, issue comments, thread resolve, requested reviewers, labels, workflow re-runs. Never merge, never the default branch, never settings. " +
  "notify {message} tells the owner. memory-capture {text,tags:[decision|lesson|person|commitment|norm]}, memory-search {query,limit?}. host-command {args?} runs an owner-granted command. " +
  "npm-package {name,version} stages a package for bun install --offline. Older grants: github-checkout/github-read/github-review, http (exact URL/method), mcp (exact arguments).";

/** The wire body each of the two session tools sends to the runtime. */
export function sessionToolBody(
  tool: "sandbox" | "broker",
  params: Record<string, unknown>,
): unknown {
  if (tool === "sandbox") return { kind: "sandbox", command: params.command };
  return params.manifest === true
    ? { kind: "manifest" }
    : { kind: "broker", operation: params.operation };
}

export async function invokeSession(
  session: SessionDescriptor,
  body: unknown,
  signal?: AbortSignal,
): Promise<{ text: string; ok: boolean }> {
  const response = await fetch(session.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  return { text: await response.text(), ok: response.ok };
}

/** ONLY two trusted tool implementations execute in a bounded turn. */
export function phantombotSecurityExtension(
  pi: SecurityExtensionApi,
  env = process.env,
): void {
  if (env[ENV_SECURITY_SESSION] === undefined) return;
  const session = sessionFromEnv(env);
  pi.on("tool_call", (e) =>
    !session || !["sandbox", "broker"].includes(e.toolName)
      ? {
          block: true,
          reason:
            "This tool is outside the sandbox and grants. Request an owner-authorized permission expansion; do not route around it.",
        }
      : undefined,
  );
  if (!session) return;
  const invoke = async (body: unknown, signal?: AbortSignal) => {
    const r = await invokeSession(session, body, signal);
    return {
      content: [{ type: "text", text: r.text }],
      ...(r.ok ? {} : { isError: true }),
    };
  };
  pi.registerTool({
    name: "sandbox",
    label: "Sandbox",
    description: SANDBOX_TOOL_DESCRIPTION,
    parameters: Type.Object({ command: Type.String() }),
    execute: (_id, p, signal) => invoke(sessionToolBody("sandbox", p), signal),
  });
  pi.registerTool({
    name: "broker",
    label: "Granted API",
    description: BROKER_TOOL_DESCRIPTION,
    parameters: Type.Object({
      manifest: Type.Optional(Type.Boolean()),
      operation: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    execute: (_id, p, signal) => invoke(sessionToolBody("broker", p), signal),
  });
}
