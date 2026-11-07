import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { CapabilityBroker, PolicyError, SandboxArchive } from "./broker.ts";
import { publicGrant, validatePolicy } from "./policy.ts";
import { deleteWindowsProfile } from "./windows.ts";
import { prepareSandboxTools } from "./workspace.ts";
import { defaultSandboxHostPaths, runSandbox, type SandboxHostPaths } from "./sandbox.ts";
import type {
  BrokerOperation,
  SecurityAudit,
  SecurityPolicy,
  SessionDescriptor,
} from "./types.ts";
import { openPersonaVault, readAllVaultValues, vaultPath, type Vault } from "../lib/vault.ts";
import { loadRegistry } from "../mcp/registry.ts";
import { McpHub } from "../mcp/hub.ts";
import { phantombotSelfCommand } from "../lib/embeddedPi.ts";

const MEMORY_TAGS = new Set(["decision", "lesson", "person", "commitment", "norm"]);
/** Model text never starts an argv word with "-" (no flag injection). */
const argText = (s: string) => (s.startsWith("-") ? ` ${s}` : s);

/** The persona's own phantombot, on the host, fixed argv, no shell. */
async function runSelf(
  args: string[],
  signal: AbortSignal,
): Promise<{ code: number; output: string }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  // The host-side command must run for real, never forward back to a session.
  delete env[ENV_SECURITY_SESSION];
  const proc = Bun.spawn([...phantombotSelfCommand(), ...args], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: (out + err).slice(0, 64 * 1024) };
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
  /** The turn's conversation and id, passed to sandboxed commands as on a trusted turn. */
  conversation?: string;
  turnId?: string;
  /**
   * The turn's untrusted scratch dir (PHANTOMBOT_SCRATCH): the sandbox's ONLY
   * writable directory. Must be a fresh, empty dir under
   * <persona>/scratch/untrusted/; absent (scratch is fail-open) = a private
   * runtime dir under <persona>/sandbox/.
   */
  workspace?: string;
  /** Read-only host paths; default = defaultSandboxHostPaths(). */
  hostPaths?: SandboxHostPaths;
}): Promise<{ descriptor: SessionDescriptor; close(): Promise<void> }> {
  const policy = validatePolicy(options.policy);
  if (!policy.enabled) throw new Error("bounded security is disabled");
  const workspace = options.workspace
    ? scratchWorkspace(options.personaDir, options.workspace)
    : (() => {
        const root = join(options.personaDir, "sandbox");
        mkdirSync(root, { recursive: true, mode: 0o700 });
        return mkdtempSync(join(root, "run-"));
      })();
  const hostPaths = options.hostPaths ?? defaultSandboxHostPaths();
  prepareSandboxTools(workspace);
  const abort = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([abort.signal, options.signal])
    : abort.signal;
  let vault: Vault | undefined, hub: McpHub | undefined;
  const needVault = async () =>
    (vault ??= await openPersonaVault(options.personaDir));
  const persona = options.persona ?? basename(options.personaDir);
  // GHSA-w7w8: every sandboxed command gets the WHOLE persona vault in its
  // env (the owner's call: no per-job secret lists). Read in the parent on
  // first use; a persona with no vault still runs, with none.
  let secrets: Record<string, string> | undefined;
  const sandboxSecrets = async () => {
    if (secrets) return secrets;
    // Only an existing vault: never provision an identity or vault here.
    const read = existsSync(vaultPath(options.personaDir))
      ? await readAllVaultValues(options.personaDir).catch(() => null)
      : null;
    return (secrets = Object.fromEntries(read?.values ?? []));
  };
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
    const broker = new CapabilityBroker(policy, {
      secret: (name) => vault?.get(name),
      signal,
      audit: options.audit,
      mcp: async (server, tool, args) => {
        hub ??= new McpHub(
          await loadRegistry(options.personaDir),
          await needVault(),
        );
        return hub.call(server, tool, args);
      },
    });
    const token = randomBytes(32).toString("hex");
    // Set once the server listens; sandboxed `phantombot` uses it to reach
    // memory and notify through this session.
    let sessionEnv: string | undefined;
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
            ) {
              return Response.json(
                await runSandbox(workspace, v.command, {
                  signal,
                  secrets: await sandboxSecrets(),
                  hostPaths,
                  context: {
                    persona,
                    conversation: options.conversation,
                    turnId: options.turnId,
                    session: sessionEnv,
                  },
                }),
              );
            }
            if (v.kind !== "broker")
              throw new PolicyError(
                "policy_denied",
                "unknown session operation",
              );
            const op = v.operation as Record<string, unknown> | undefined;
            // The persona's own notify and memory, on the host (the sandbox
            // has no identity.json): fixed argv.
            if (op?.kind === "notify" && typeof op.message === "string" && op.message.length <= 4096) {
              const r = await runSelf(["notify", "--persona", persona, "--message", argText(op.message)], signal);
              if (r.code !== 0) throw new PolicyError("unavailable", "notify failed");
              return Response.json({ result: { sent: true } });
            }
            if (op?.kind === "memory-capture" && typeof op.text === "string" && op.text.length <= 8192) {
              const tags = Array.isArray(op.tags) ? op.tags.filter((t): t is string => typeof t === "string" && MEMORY_TAGS.has(t)) : [];
              const r = await runSelf(["memory", "capture", argText(op.text), "--persona", persona, ...tags.flatMap((t) => ["--tag", t])], signal);
              if (r.code !== 0) throw new PolicyError("unavailable", "memory capture failed");
              return Response.json({ result: { captured: true } });
            }
            if (op?.kind === "memory-search" && typeof op.query === "string" && op.query.length <= 1024) {
              const limit = typeof op.limit === "number" && op.limit >= 1 && op.limit <= 20 ? Math.floor(op.limit) : 8;
              const r = await runSelf(["memory", "search", argText(op.query), "--persona", persona, "--limit", String(limit)], signal);
              if (r.code !== 0) throw new PolicyError("unavailable", "memory search failed");
              return Response.json({ result: r.output });
            }
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
    sessionEnv = JSON.stringify({
      url: `http://127.0.0.1:${server.port}/operation`,
      token,
      workspace,
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

/** Only a fresh, empty dir under <persona>/scratch/untrusted/ is accepted. */
function scratchWorkspace(personaDir: string, dir: string): string {
  const root = realpathSync(join(personaDir, "scratch", "untrusted"));
  const real = realpathSync(dir);
  const rel = relative(root, real);
  if (!rel || rel.startsWith("..") || rel.split(sep).includes(".."))
    throw new Error("sandbox workspace must be untrusted scratch");
  if (readdirSync(real).length) throw new Error("sandbox workspace not empty");
  return real;
}
