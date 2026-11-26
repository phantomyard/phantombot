/**
 * Build the `--mcp-config` payload phantombot hands to MCP-native harnesses so
 * they see phantombot's OWN registered servers — and ONLY those.
 *
 * This is the other half of the account-connector isolation fix (issue #338):
 * phantombot's claude harness always runs `--strict-mcp-config`, which tells
 * claude to use exclusively the servers in `--mcp-config` and ignore
 * `~/.claude.json` + the account-level claude.ai connectors (IBKR / Gmail /
 * Calendar / Drive). Those connectors are wanted on Claude Desktop but are pure
 * noise (and an untrusted-input surface) inside a phantombot prompt.
 *
 * Since #820 the proxy is projected on EVERY foreground turn, registered
 * servers or not: it carries the typed `pbot_*` tools (src/pbot/), which every
 * persona has. The persona's upstream servers are opened lazily inside the
 * proxy, so a persona with none still costs no upstream child process, and a
 * broken registry only blinds the upstream half — the pbot_* tools keep
 * working. Background/nightly turns (mcpMode "none") still get
 * EMPTY_MCP_CONFIG, and the isolation guarantee holds either way because
 * strict-mcp-config is on.
 */

import { loadConfig } from "../config.ts";
import { TRUSTED_ENV_VAR } from "../lib/envBootstrap.ts";
import {
  currentEngineScope,
  HOST_LOCATION_ENV,
  scopedChildEnv,
} from "../lib/engineScope.ts";

/** Empty (zero-server) strict config — the safe default and the nightly/background payload. */
export const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';

/**
 * The argv that re-invokes THIS phantombot to run the proxy. Mirrors the
 * dev/compiled split used elsewhere (cli/doctor.ts): under a compiled binary
 * `process.execPath` IS phantombot; under `bun src/index.ts` we must pass the
 * entrypoint as the first arg.
 */
export function proxyInvocation(persona?: string): { command: string; args: string[] } {
  const entry = process.argv[1] ?? "";
  const dev = entry.endsWith(".ts") || entry.endsWith(".js");
  const base = dev ? [entry, "mcp", "proxy"] : ["mcp", "proxy"];
  const args = persona ? [...base, "--persona", persona] : base;
  return { command: process.execPath, args };
}

/** The turn the proxy child serves. Passed explicitly: an MCP client is not
 * required to hand its own environment to a stdio server (codex does not). */
export interface ProxyTurnContext {
  conversation?: string;
  turnId?: string;
  trusted?: boolean;
}

/**
 * The env a proxy child needs to act for this turn: which conversation a
 * capture belongs to, the trust tier (`pbot_device` refuses untrusted turns),
 * and the location env that finds personas and the vault (proxyLocationEnv).
 * Never a secret: the proxy opens the vault itself.
 */
export function proxyEnv(persona: string, ctx: ProxyTurnContext = {}): Record<string, string> {
  return {
    ...proxyLocationEnv(),
    PHANTOMBOT_PERSONA: persona,
    ...(ctx.conversation ? { PHANTOMBOT_CONVERSATION: ctx.conversation } : {}),
    ...(ctx.turnId ? { PHANTOMBOT_TURN_ID: ctx.turnId } : {}),
    ...(ctx.trusted === true ? { [TRUSTED_ENV_VAR]: "1" } : {}),
  };
}

/** The XDG base directories phantombot derives its stores from (config.ts). */
const XDG_LOCATION_ENV = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"] as const;

/**
 * Where the proxy child must look for personas, vault, registry and memory.
 *
 * Inside an engine scope: exactly the scoped roots + marker (scopedChildEnv);
 * host location overrides are deliberately NOT forwarded there, so an
 * embedding application is never aimed at the host's stores.
 *
 * Outside a scope (the CLI/daemon): the parent's own XDG roots and host
 * location overrides, explicitly. An MCP client need not pass its environment
 * to a stdio child — codex does not — so without this a daemon running on
 * custom roots would start a proxy against the DEFAULT stores. Locations only;
 * never a secret.
 */
export function proxyLocationEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  if (currentEngineScope()) return scopedChildEnv();
  const out: Record<string, string> = {};
  for (const k of [...XDG_LOCATION_ENV, ...HOST_LOCATION_ENV]) {
    const v = env[k];
    if (v) out[k] = v;
  }
  return out;
}

/**
 * Resolve the `--mcp-config` JSON string for a FOREGROUND claude turn: always
 * the single `phantombot` proxy server (#820). Best-effort: any failure
 * resolves to the empty config, so a broken config can never break a turn —
 * it just means no tools from phantombot this turn (and connectors stay
 * isolated regardless). Exported for testing.
 */
export async function buildForegroundMcpConfig(
  persona: string | undefined,
  ctx: ProxyTurnContext = {},
): Promise<string> {
  try {
    const name = await resolveProxyPersona(persona);
    const { command, args } = proxyInvocation(name);
    return JSON.stringify({ mcpServers: { phantombot: { command, args, env: proxyEnv(name, ctx) } } });
  } catch {
    return EMPTY_MCP_CONFIG;
  }
}

async function resolveProxyPersona(persona: string | undefined): Promise<string> {
  if (persona) return persona;
  const cfg = await loadConfig();
  return process.env.PHANTOMBOT_PERSONA || cfg.defaultPersona;
}
