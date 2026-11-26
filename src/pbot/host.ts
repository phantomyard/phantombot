/**
 * Build the ToolCatalog for the process that hosts the `pbot_*` tools — the
 * `phantombot mcp proxy` child of claude/codex, or the `phantombot __pi`
 * engine. Context comes from the env the harness gave that child
 * (PHANTOMBOT_PERSONA / PHANTOMBOT_CONVERSATION / PHANTOMBOT_TRUSTED); the
 * persona's registered MCP servers are opened lazily, on the first upstream
 * search/describe/call.
 */

import { loadConfig } from "../config.ts";
import { resolvePersona, personaDir } from "../config.ts";
import { McpHub } from "../mcp/hub.ts";
import { loadRegistry } from "../mcp/registry.ts";
import { openPersonaVault, type Vault } from "../lib/vault.ts";
import { ToolCatalog } from "./catalog.ts";
import { pbotContextFromEnv } from "./tools.ts";

/** McpHub that also closes the vault it borrowed. */
class OwningHub extends McpHub {
  constructor(
    registry: ConstructorParameters<typeof McpHub>[0],
    private readonly ownedVault: Vault,
  ) {
    super(registry, ownedVault);
  }
  override async close(): Promise<void> {
    await super.close();
    try {
      this.ownedVault.close();
    } catch {
      /* best effort */
    }
  }
}

/** Open the persona's upstream MCP servers, or undefined when it has none. */
export async function openPersonaHub(persona: string | undefined): Promise<McpHub | undefined> {
  const config = await loadConfig();
  const dir = personaDir(config, resolvePersona(persona, config));
  const registry = await loadRegistry(dir);
  if (Object.keys(registry.mcpServers).length === 0) return undefined;
  return new OwningHub(registry, await openPersonaVault(dir));
}

export function buildHostCatalog(
  env: NodeJS.ProcessEnv = process.env,
  explicitPersona?: string,
): ToolCatalog {
  const ctx = pbotContextFromEnv(env);
  if (explicitPersona) ctx.persona = explicitPersona;
  return new ToolCatalog({ ctx, hub: () => openPersonaHub(ctx.persona) });
}
