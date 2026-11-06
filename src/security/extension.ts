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
/** ONLY two trusted tool implementations execute in a bounded turn. */
export function phantombotSecurityExtension(
  pi: SecurityExtensionApi,
  env = process.env,
): void {
  const raw = env[ENV_SECURITY_SESSION];
  if (raw === undefined) return;
  let session: SessionDescriptor | undefined;
  try {
    const s = JSON.parse(raw) as SessionDescriptor;
    const u = new URL(s.url);
    if (
      u.protocol === "http:" &&
      u.hostname === "127.0.0.1" &&
      u.pathname === "/operation" &&
      /^[a-f0-9]{64}$/.test(s.token)
    )
      session = s;
  } catch {
    /* registers a closed hook */
  }
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
    const response = await fetch(session!.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session!.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
    const result = await response.text();
    return {
      content: [{ type: "text", text: result }],
      ...(response.ok ? {} : { isError: true }),
    };
  };
  pi.registerTool({
    name: "sandbox",
    label: "Sandbox",
    description:
      "Run shell commands in the disposable workspace. No credentials, host files or direct network. Reads, edits, installs from cached dependencies, tests and cleanup are permitted without further model checks.",
    parameters: Type.Object({ command: Type.String() }),
    execute: (_id, p, signal) =>
      invoke({ kind: "sandbox", command: p.command }, signal),
  });
  pi.registerTool({
    name: "broker",
    label: "Granted API",
    description:
      "Call credentialed APIs under exact owner grants. Call {manifest:true} to list grants; otherwise supply operation: {kind,grant,...}. GitHub: github-checkout head (extracts into repository/); github-read resource pull/files/comments/reviews; github-review head,event,body,comments. HTTP uses granted URL/method. MCP requires exact granted arguments. npm-package name/version stages a package into the Bun offline cache under an npm-registry grant; install with bun install --offline. Team review grants also require pullRequest. No model permission checks.",
    parameters: Type.Object({
      manifest: Type.Optional(Type.Boolean()),
      operation: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    execute: (_id, p, signal) =>
      invoke(
        p.manifest === true
          ? { kind: "manifest" }
          : { kind: "broker", operation: p.operation },
        signal,
      ),
  });
}
