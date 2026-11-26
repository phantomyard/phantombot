/**
 * The pi adapter for the shared tool catalog (issue #820).
 *
 * An inline extension of the EMBEDDED pi engine (`phantombot __pi`, see
 * lib/embeddedPi.ts). It converts the catalog's MCP-shaped tools — the
 * `pbot_*` tools and the persona's registered servers' tools — into native pi
 * tools and runs them IN THIS PROCESS: a pbot call is a function call into the
 * same `run*` action the CLI uses, with no MCP server hop and no `phantombot`
 * process spawn.
 *
 * Loading follows the catalog's one rule: the eager core (`pbot_memory`,
 * `pbot_vault`, `pbot_tools`) registers at load; a lazy tool registers the
 * moment `pbot_tools describe` loads it (pi re-reads its registry on a late
 * `registerTool` and activates the new tool for the next model call). Until
 * then `pbot_tools call` reaches it with the same validation.
 *
 * Registers NOTHING unless the harness set PHANTOMBOT_PBOT_TOOLS=1 for this
 * spawn (normal foreground native turns only) — a judge, background or
 * sandboxed turn keeps exactly today's tool surface. Sandboxed turns are
 * refused twice: a live security session also disables registration.
 */

import { ENV_SECURITY_SESSION } from "../security/session.ts";
import type { CatalogResult, CatalogToolSchema, ToolCatalog } from "./catalog.ts";
import { ENV_PBOT_TOOLS, PBOT_TOOLS_NAME } from "./env.ts";

export { ENV_PBOT_TOOLS };

/** The slice of pi's ExtensionAPI this adapter uses. */
export interface PbotPiApi {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    execute(
      id: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<{ content: CatalogResult["content"]; details: unknown; isError?: boolean }>;
  }): void;
}

/** Whether this pi process should host the pbot_* tools. */
export function pbotToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ENV_PBOT_TOOLS] === "1" && env[ENV_SECURITY_SESSION] === undefined;
}

function toPiResult(r: CatalogResult) {
  return r.isError
    ? { content: r.content, details: {}, isError: true }
    : { content: r.content, details: {} };
}

/**
 * Register the catalog's tools on a pi extension API. Exported with the
 * catalog as a parameter so tests can drive it with a fake pi and fake
 * catalog; production goes through `phantombotPbotExtension`.
 */
export function registerCatalogOnPi(pi: PbotPiApi, catalog: ToolCatalog): void {
  const registered = new Set<string>();
  const register = (schema: CatalogToolSchema) => {
    if (registered.has(schema.name)) return;
    registered.add(schema.name);
    pi.registerTool({
      name: schema.name,
      label: schema.name,
      description: schema.description,
      parameters: schema.inputSchema,
      async execute(_id, params) {
        const result = await catalog.call(schema.name, params ?? {});
        // A describe loaded a lazy tool: make it native for the rest of the
        // turn. Registration failing is not fatal — pbot_tools call still works.
        if (schema.name === PBOT_TOOLS_NAME) {
          for (const t of catalog.activeTools()) {
            if (!registered.has(t.name)) {
              try {
                register(t);
              } catch {
                registered.delete(t.name);
              }
            }
          }
        }
        return toPiResult(result);
      },
    });
  };
  for (const t of catalog.initialTools()) register(t);
}

/** The inline extension factory embeddedPi hands to pi's main(). */
export async function phantombotPbotExtension(pi: PbotPiApi): Promise<void> {
  if (!pbotToolsEnabled()) return;
  const { buildHostCatalog } = await import("./host.ts");
  registerCatalogOnPi(pi, buildHostCatalog(process.env));
}
