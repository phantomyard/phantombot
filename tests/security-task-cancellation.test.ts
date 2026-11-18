import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTaskStore, type TaskStore } from "../src/lib/tasks.ts";
import { createSecuritySession } from "../src/security/session.ts";
import { invokeSession } from "../src/security/extension.ts";
import { createTaskCapability, ENV_TASK_CAPABILITY, inheritedTaskCancellation, taskCancellation } from "../src/security/taskCancellation.ts";
import type { SecurityAudit } from "../src/security/types.ts";
import { runTaskCancel } from "../src/cli/task.ts";

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pb-self-cancel-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = await openTaskStore(join(dir, "tasks.sqlite"));
  cleanups.push(() => store.close());
  const add = (persona: string) => {
    const result = store.add({ persona, schedule: "*/5 * * * *", prompt: "check", description: "check" });
    if (!result.ok) throw new Error(result.error);
    return result.task.id;
  };
  const id = add("kai"), other = add("kai"), foreign = add("lena");
  const authority = taskCancellation(store, id, "kai");
  return { dir, store, id, other, foreign, authority };
}

test("real broker cancels only its host-bound task, audits denial and permits retries", async () => {
  const f = await fixture();
  const audits: SecurityAudit[] = [];
  const session = await createSecuritySession({ personaDir: f.dir, persona: "kai", policy: { version: 1, enabled: true, grants: [] }, taskCancellation: f.authority, audit: e => audits.push(e) });
  cleanups.push(() => session.close());
  const cancel = (id: unknown, persona?: string) => invokeSession(session.descriptor, { kind: "broker", operation: { kind: "task-cancel", id, persona } });
  for (const id of [f.other, f.foreign, -1, "1", null]) expect((await cancel(id)).ok).toBe(false);
  expect((await cancel(f.id, "lena")).ok).toBe(false);
  expect(f.store.get(f.id)!.active).toBe(true);
  expect((await cancel(f.id)).ok).toBe(true);
  expect((await cancel(f.id)).ok).toBe(true);
  expect(f.store.get(f.id)!.active).toBe(false);
  expect(f.store.get(f.other)!.active).toBe(true);
  expect(f.store.get(f.foreign)!.active).toBe(true);
  expect(audits.filter(a => a.operation === "task-cancel").map(a => a.outcome)).toEqual([...Array(6).fill("policy_denied"), "allowed", "allowed"]);
});

test("a conversation task id and forged operation cannot grant a normal session authority", async () => {
  const f = await fixture();
  const session = await createSecuritySession({ personaDir: f.dir, persona: "kai", conversation: `tick:${f.id}`, policy: { version: 1, enabled: true, grants: [] } });
  cleanups.push(() => session.close());
  const r = await invokeSession(session.descriptor, { kind: "broker", operation: { kind: "task-cancel", id: f.id, taskCancellation: f.authority } });
  expect(r.ok).toBe(false);
  expect(f.store.get(f.id)!.active).toBe(true);
});

test("command capability survives authenticated ask handoff but rejects persona, token, target and expiry", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const cap = createTaskCapability(f.authority, abort.signal);
  cleanups.push(() => cap.close());
  const env = { [ENV_TASK_CAPABILITY]: cap.descriptor };
  expect(await inheritedTaskCancellation("lena", undefined, env)).toBeUndefined();
  const forged = { ...JSON.parse(cap.descriptor), token: "0".repeat(64) };
  expect(await inheritedTaskCancellation("kai", undefined, { [ENV_TASK_CAPABILITY]: JSON.stringify(forged) })).toBeUndefined();
  expect(await inheritedTaskCancellation("kai", undefined, { PHANTOMBOT_TASK_ID: String(f.id) })).toBeUndefined();
  const inherited = await inheritedTaskCancellation("kai", undefined, env);
  expect(inherited?.id).toBe(f.id);
  const { url, token } = JSON.parse(cap.descriptor);
  expect((await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ kind: "cancel", id: f.other, persona: "kai" }) })).ok).toBe(false);
  const session = await createSecuritySession({ personaDir: f.dir, persona: "kai", policy: { version: 1, enabled: true, grants: [] }, taskCancellation: inherited });
  cleanups.push(() => session.close());
  expect((await invokeSession(session.descriptor, { kind: "broker", operation: { kind: "task-cancel", id: f.id } })).ok).toBe(true);
  expect(f.store.get(f.id)!.active).toBe(false);
  expect(f.store.get(f.other)!.active).toBe(true);
  abort.abort();
  await expect(inherited!.cancel()).rejects.toThrow();
  await cap.close();
  expect(await inheritedTaskCancellation("kai", undefined, env)).toBeUndefined();
});

test("aborted turn cannot cancel; closed security session loses authority", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const session = await createSecuritySession({ personaDir: f.dir, persona: "kai", policy: { version: 1, enabled: true, grants: [] }, taskCancellation: f.authority, signal: abort.signal });
  cleanups.push(() => session.close());
  abort.abort();
  expect((await invokeSession(session.descriptor, { kind: "broker", operation: { kind: "task-cancel", id: f.id } })).ok).toBe(false);
  expect(f.store.get(f.id)!.active).toBe(true);
  await session.close();
  await expect(invokeSession(session.descriptor, { kind: "broker", operation: { kind: "task-cancel", id: f.id } })).rejects.toThrow();
});

test("sandbox CLI forwards cancellation before opening any config or task store", async () => {
  const f = await fixture();
  const session = await createSecuritySession({ personaDir: f.dir, persona: "kai", policy: { version: 1, enabled: true, grants: [] }, taskCancellation: f.authority });
  cleanups.push(() => session.close());
  const previous = process.env.PHANTOMBOT_SECURITY_SESSION;
  process.env.PHANTOMBOT_SECURITY_SESSION = JSON.stringify(session.descriptor);
  try {
    let output = "";
    expect(await runTaskCancel({ id: f.id, out: { write: s => { output += s; } }, store: {} as TaskStore })).toBe(0);
    expect(output).toBe(`task ${f.id} cancelled\n`);
    expect(f.store.get(f.id)!.active).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.PHANTOMBOT_SECURITY_SESSION;
    else process.env.PHANTOMBOT_SECURITY_SESSION = previous;
  }
});


test.skipIf(!process.env.PHANTOMBOT_TEST_SELF_CANCEL_BINARY)("compiled CLI self-cancels inside the real OS sandbox", async () => {
  const f = await fixture();
  const session = await createSecuritySession({ personaDir: f.dir, persona: "kai", policy: { version: 1, enabled: true, grants: [] }, taskCancellation: f.authority });
  cleanups.push(() => session.close());
  copyFileSync(process.env.PHANTOMBOT_TEST_SELF_CANCEL_BINARY!, join(session.descriptor.workspace, "phantombot"));
  const result = await invokeSession(session.descriptor, { kind: "sandbox", command: `./phantombot task cancel ${f.id}` });
  expect(result.ok, result.text).toBe(true);
  expect(JSON.parse(result.text)).toMatchObject({ exitCode: 0 });
  expect(JSON.parse(result.text).output).toContain(`task ${f.id} cancelled`);
  expect(f.store.get(f.id)!.active).toBe(false);
  const other = await invokeSession(session.descriptor, { kind: "sandbox", command: `./phantombot task cancel ${f.other}` });
  expect(JSON.parse(other.text).exitCode).not.toBe(0);
  expect(f.store.get(f.other)!.active).toBe(true);
  const denied = await invokeSession(session.descriptor, { kind: "sandbox", command: `cat '${join(f.dir, "tasks.sqlite")}'` });
  expect(JSON.parse(denied.text).exitCode).not.toBe(0);
}, 30000);
