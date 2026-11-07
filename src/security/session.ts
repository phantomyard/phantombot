import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { CapabilityBroker, PolicyError, SandboxArchive } from "./broker.ts";
import { publicGrant, validatePolicy } from "./policy.ts";
import { deleteWindowsProfile } from "./windows.ts";
import { prepareSandboxTools } from "./workspace.ts";
import { runSandbox } from "./sandbox.ts";
import type {
  BrokerOperation,
  SecurityAudit,
  SecurityPolicy,
  SessionDescriptor,
} from "./types.ts";
import { openPersonaVault, type Vault } from "../lib/vault.ts";
import { loadRegistry } from "../mcp/registry.ts";
import { McpHub } from "../mcp/hub.ts";
import { harnessSpawnEnv } from "../lib/vault.ts";
import { phantombotSelfCommand } from "../lib/embeddedPi.ts";
import { WorkflowBroker, WORKFLOW_GRANT_KINDS, type HostRun } from "./workflow.ts";

/** Host argv runner for the workflow broker: no shell, bounded output and time. */
async function runHost(
  argv: string[],
  opts: { env?: Record<string, string>; stdin?: Uint8Array; timeoutMs: number },
  signal: AbortSignal,
): Promise<HostRun> {
  const proc = Bun.spawn(argv, {
    env: opts.env ?? {},
    stdin: opts.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.any([signal, AbortSignal.timeout(opts.timeoutMs)]),
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout: new Uint8Array(stdout), stderr };
}

export const ENV_SECURITY_SESSION = "PHANTOMBOT_SECURITY_SESSION";
/** The owner/runtime creates this; neither model text nor repository files can. */
export async function createSecuritySession(options: {
  personaDir: string;
  policy: SecurityPolicy;
  signal?: AbortSignal;
  audit?: (event: SecurityAudit) => void;
  /** Persona name for notify/memory; default = the persona dir's name. */
  persona?: string;
  /** The escort at the sandbox boundary (escortGate.ts); absent = grants alone. */
  gate?: (grant: import("./types.ts").NetworkGrant, op: BrokerOperation) => Promise<void>;
}): Promise<{ descriptor: SessionDescriptor; close(): Promise<void> }> {
  const policy = validatePolicy(options.policy);
  if (!policy.enabled) throw new Error("bounded security is disabled");
  const root = join(options.personaDir, "sandbox");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const workspace = mkdtempSync(join(root, "run-"));
  prepareSandboxTools(workspace);
  const abort = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([abort.signal, options.signal])
    : abort.signal;
  let vault: Vault | undefined, hub: McpHub | undefined;
  const needVault = async () =>
    (vault ??= await openPersonaVault(options.personaDir));
  // Load secrets in the parent only. There is no credential endpoint on IPC.
  try {
    if (
      policy.grants.some(
        (g) =>
          ["github-review", "github-team-review", "mcp"].includes(g.kind) ||
          (g.kind === "http" && g.credential),
      )
    )
      await needVault();
    const persona = options.persona ?? basename(options.personaDir);
    const workflow = policy.grants.some((g) => WORKFLOW_GRANT_KINDS.has(g.kind))
      ? new WorkflowBroker({
          workspace,
          host: (argv, o) => runHost(argv, o, signal),
          sandbox: (command) => runSandbox(workspace, command, { signal }),
          self: phantombotSelfCommand(),
          persona,
          personaEnv: async () => {
            const env = await harnessSpawnEnv(persona);
            const out: Record<string, string> = {};
            for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
            out.PHANTOMBOT_PERSONA = persona;
            return out;
          },
          // Opened on first use: a turn that never touches GitHub never
          // opens the vault (and a persona without one still runs).
          secret: async (name) => (await needVault()).get(name),
          signal,
        })
      : undefined;
    const broker = new CapabilityBroker(policy, {
      secret: (name) => vault?.get(name),
      signal,
      audit: options.audit,
      workflow,
      gate: options.gate,
      mcp: async (server, tool, args) => {
        hub ??= new McpHub(
          await loadRegistry(options.personaDir),
          await needVault(),
        );
        return hub.call(server, tool, args);
      },
    });
    const token = randomBytes(32).toString("hex");
    let closed = false;
    const requests = new Set<Promise<unknown>>();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      maxRequestBodySize: 1024 * 1024,
      async fetch(request) {
        const received = request.headers.get("authorization") ?? "";
        const expected = `Bearer ${token}`;
        if (
          closed ||
          received.length !== expected.length ||
          !timingSafeEqual(Buffer.from(received), Buffer.from(expected)) ||
          request.method !== "POST" ||
          new URL(request.url).pathname !== "/operation"
        )
          return new Response(null, { status: 403 });
        const run = async () => {
          try {
            const v = (await request.json()) as {
              kind?: unknown;
              command?: unknown;
              operation?: unknown;
            };
            if (v.kind === "manifest")
              return Response.json({
                workspace,
                grants: policy.grants.map(publicGrant),
              });
            if (
              v.kind === "sandbox" &&
              typeof v.command === "string" &&
              v.command.length <= 256 * 1024
            )
              return Response.json(
                await runSandbox(workspace, v.command, { signal }),
              );
            if (v.kind !== "broker")
              throw new PolicyError(
                "policy_denied",
                "unknown session operation",
              );
            const result = await broker.execute(v.operation as BrokerOperation);
            if (result instanceof SandboxArchive) {
              // Directory comes only from the typed broker, never an arbitrary
              // upstream reply. Archive extraction itself is sandboxed too.
              const directory = result.directory;
              const command =
                process.platform === "win32"
                  ? `if not exist "${directory}" mkdir "${directory}" & tar -xzf - --strip-components=1 -C "${directory}"`
                  : `mkdir -p '${directory}' && tar -xzf - --strip-components=1 -C '${directory}'`;
              const extraction = await runSandbox(workspace, command, {
                signal,
                stdin: result.bytes,
              });
              return Response.json({ directory, ...extraction });
            }
            return Response.json({ result });
          } catch (error) {
            const e =
              error instanceof PolicyError
                ? error
                : new PolicyError(
                    "unavailable",
                    "session operation unavailable",
                  );
            return Response.json(
              { error: e.message, outcome: e.outcome },
              { status: 409 },
            );
          }
        };
        const result = run();
        requests.add(result);
        try {
          return await result;
        } finally {
          requests.delete(result);
        }
      },
    });
    const close = async () => {
      if (closed) return;
      closed = true;
      abort.abort();
      await server.stop(true);
      await Promise.allSettled([...requests]);
      await hub?.close();
      vault?.close();
      deleteWindowsProfile(workspace);
      rmSync(workspace, { recursive: true, force: true });
    };
    return {
      descriptor: {
        url: `http://127.0.0.1:${server.port}/operation`,
        token,
        workspace,
      },
      close,
    };
  } catch (error) {
    vault?.close();
    rmSync(workspace, { recursive: true, force: true });
    throw error;
  }
}
