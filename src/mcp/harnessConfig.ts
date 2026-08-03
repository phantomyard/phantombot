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
 * The projection is lazy and safe-by-default:
 *   - persona has NO registered MCP servers  -> `{"mcpServers":{}}`  (zero
 *     child processes; byte-identical to the long-standing nightly path). The
 *     isolation guarantee still holds because strict-mcp-config is on.
 *   - persona has >=1 registered server      -> a single `phantombot` stdio
 *     server pointing at `phantombot mcp proxy`, which aggregates every
 *     registered upstream behind the lazy discovery meta-tools (see proxy.ts).
 */

import { loadConfig, personaDir } from "../config.ts";
import { loadRegistry } from "./registry.ts";

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

/**
 * Resolve the `--mcp-config` JSON string for a FOREGROUND claude turn. Best-
 * effort: any failure resolves to the empty config, so a broken registry can
 * never break a turn — it just means no MCP this turn (and connectors stay
 * isolated regardless). Exported for testing.
 */
export async function buildForegroundMcpConfig(persona: string | undefined): Promise<string> {
  try {
    const cfg = await loadConfig();
    const name = persona || process.env.PHANTOMBOT_PERSONA || cfg.defaultPersona;
    const registry = await loadRegistry(personaDir(cfg, name));
    if (Object.keys(registry.mcpServers).length === 0) return EMPTY_MCP_CONFIG;
    const { command, args } = proxyInvocation(name);
    return JSON.stringify({ mcpServers: { phantombot: { command, args } } });
  } catch {
    return EMPTY_MCP_CONFIG;
  }
}
