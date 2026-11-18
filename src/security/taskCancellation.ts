import { randomBytes, timingSafeEqual } from "node:crypto";
import type { TaskStore } from "../lib/tasks.ts";
import { PolicyError } from "./broker.ts";

/** Host-owned authority. IDs in prompts, conversation keys or env grant nothing. */
export interface TaskCancellation {
  readonly id: number;
  readonly persona: string;
  cancel(): Promise<string>;
}

export function taskCancellation(store: TaskStore, id: number, persona: string): TaskCancellation {
  return {
    id, persona,
    async cancel() {
      const task = store.get(id);
      if (!task || task.persona !== persona)
        throw new PolicyError("policy_denied", "originating task unavailable");
      if (!store.cancel(id)) throw new PolicyError("unavailable", "task cancellation failed");
      return `task ${id} cancelled`;
    },
  };
}

export const ENV_TASK_CAPABILITY = "PHANTOMBOT_TASK_CAPABILITY";

/** A command poller's ask child borrows only this capability, never a DB path. */
export function createTaskCapability(authority: TaskCancellation, signal: AbortSignal) {
  const token = randomBytes(32).toString("hex");
  let closed = false;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, maxRequestBodySize: 4096,
    async fetch(request) {
      const received = Buffer.from(request.headers.get("authorization") ?? "");
      const expected = Buffer.from(`Bearer ${token}`);
      if (closed || signal.aborted || received.length !== expected.length ||
          !timingSafeEqual(received, expected) || request.method !== "POST" ||
          new URL(request.url).pathname !== "/task")
        return new Response(null, { status: 403 });
      try {
        const op = await request.json() as { kind?: string; persona?: string; id?: number };
        if (closed || signal.aborted || op.persona !== authority.persona)
          throw new Error("denied");
        if (op.kind === "context") return Response.json({ id: authority.id });
        if (op.kind !== "cancel" || op.id !== authority.id) throw new Error("denied");
        return Response.json({ result: await authority.cancel() });
      } catch {
        return Response.json({ error: "task capability refused" }, { status: 409 });
      }
    },
  });
  return {
    descriptor: JSON.stringify({ url: `http://127.0.0.1:${server.port}/task`, token }),
    async close() { closed = true; await server.stop(true); },
  };
}

/** A forged endpoint can only cancel through itself; it never selects a host row. */
export async function inheritedTaskCancellation(
  persona: string,
  signal?: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TaskCancellation | undefined> {
  const raw = env[ENV_TASK_CAPABILITY];
  if (!raw) return undefined;
  try {
    const descriptor = JSON.parse(raw) as { url: string; token: string };
    const url = new URL(descriptor.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/task" ||
        !/^[a-f0-9]{64}$/.test(descriptor.token)) return undefined;
    const invoke = async (operation: Record<string, unknown>) => {
      const response = await fetch(url, {
        method: "POST", redirect: "error",
        headers: { Authorization: `Bearer ${descriptor.token}` },
        body: JSON.stringify({ ...operation, persona }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new PolicyError("policy_denied", "task capability unavailable");
      return await response.json() as { id?: number; result?: string };
    };
    const { id } = await invoke({ kind: "context" });
    if (!Number.isSafeInteger(id) || id! < 1) return undefined;
    return {
      id: id!, persona,
      async cancel() {
        const { result } = await invoke({ kind: "cancel", id });
        if (typeof result !== "string") throw new PolicyError("unavailable", "task cancellation failed");
        return result;
      },
    };
  } catch {
    return undefined;
  }
}
