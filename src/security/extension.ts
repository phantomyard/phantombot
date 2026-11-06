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
  "Call credentialed APIs under exact owner grants. Call {manifest:true} to list grants; otherwise supply operation: {kind,grant,...}. GitHub: github-checkout head (extracts into repository/); github-read resource pull/files/comments/reviews; github-review head,event,body,comments. HTTP uses granted URL/method. MCP requires exact granted arguments. npm-package name/version stages a package into the Bun offline cache under an npm-registry grant; install with bun install --offline. Team review grants also require pullRequest. No model permission checks.";

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
