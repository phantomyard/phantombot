/**
 * Inside a sandboxed turn the persona folder is hidden, so `phantombot memory
 * search|capture` and `phantombot notify` cannot open it. When the runtime set
 * a session (PHANTOMBOT_SECURITY_SESSION, sandbox.ts) they forward to it
 * instead: the same host operations the broker tool runs, judged the same
 * way, so the CLI works in a sandboxed turn as it does in a trusted one.
 */
import { invokeSession, sessionFromEnv } from "./extension.ts";

interface Sink {
  write(s: string): unknown;
}

/** undefined = no session here: the caller runs normally. */
export async function forwardToSandboxSession(
  operation: Record<string, unknown>,
  out: Sink,
  err: Sink,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number | undefined> {
  const session = sessionFromEnv(env);
  if (!session) return undefined;
  try {
    const r = await invokeSession(session, { kind: "broker", operation });
    if (!r.ok) {
      err.write(`${r.text}\n`);
      return 1;
    }
    const body = JSON.parse(r.text) as { result?: unknown };
    const result = body.result;
    if (typeof result === "string") out.write(result.endsWith("\n") ? result : `${result}\n`);
    else if (operation.kind === "notify") out.write("sent\n");
    else if (operation.kind === "memory-capture") out.write("captured\n");
    return 0;
  } catch (e) {
    err.write(`sandbox session unavailable: ${(e as Error).message}\n`);
    return 1;
  }
}
