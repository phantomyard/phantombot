/**
 * MCP servers, for the Configure screen's MCP row.
 *
 * Two jobs, deliberately split:
 *
 *   - `listMcpServers` reads the persona's registry file ONLY. No network, no
 *     spawned stdio server, so the screen paints the full list instantly and a
 *     hung server cannot stop the user seeing (or deleting) it.
 *   - `probeMcpServer` connects to ONE server and counts its tools. Called per
 *     row after the list is on screen, under its own deadline.
 *
 * The first cut probed everything up front and the screen sat blank for as
 * long as the slowest `npx` cold start — which is exactly the server you
 * opened this screen to delete.
 *
 * Neither function reimplements the registry: `loadRegistry` / `removeServer` /
 * `saveRegistry` are the same readers and writers `phantombot mcp` uses, so
 * the CLI and the TUI cannot disagree about what is registered.
 */

import { openPersonaVault } from "../lib/vault.ts";
import { McpHub } from "../mcp/hub.ts";
import {
  loadRegistry,
  referencedVaultKeys,
  removeServer,
  saveRegistry,
  type McpServerEntry,
} from "../mcp/registry.ts";
import type { McpServerRow } from "./screens/Mcp.tsx";

/** How long one server gets to answer `tools/list` before we call it unreachable. */
export const PROBE_DEADLINE_MS = 10_000;

/** What a row shows for "where does this server live". */
function targetOf(entry: McpServerEntry): string {
  if (entry.transport === "stdio")
    return `${entry.command ?? ""} ${(entry.args ?? []).join(" ")}`.trim();
  return entry.url ?? "";
}

/**
 * The registered servers, straight off disk, in the CLI's sort order.
 *
 * `status: "unknown"` on every row: nothing has been probed yet. The screen
 * asks for probes itself, so the caller never pays for one it did not want.
 */
export async function listMcpServers(
  personaDir: string,
): Promise<McpServerRow[]> {
  const registry = await loadRegistry(personaDir);
  return Object.keys(registry.mcpServers)
    .sort()
    .map((name) => {
      const entry = registry.mcpServers[name]!;
      return {
        name,
        transport: entry.transport,
        auth: (entry.auth ?? { type: "none" }).type,
        target: targetOf(entry),
        status: "unknown" as const,
        secrets: referencedVaultKeys(entry),
      };
    });
}

/**
 * Connect to one server and count its tools.
 *
 * The tool COUNT is the proof of life, as `mcp status` uses it: a server that
 * accepts a connection but answers nothing to `tools/list` is not usable, and
 * reporting it green because the socket opened is the lie this screen exists
 * to avoid.
 *
 * A fresh hub and vault per probe, closed in a `finally`. Holding one hub open
 * for the screen's lifetime would leave a spawned stdio child running after
 * the user navigated away.
 */
export async function probeMcpServer(
  personaDir: string,
  name: string,
  deadlineMs: number = PROBE_DEADLINE_MS,
): Promise<{ ok: boolean; tools?: number; detail: string }> {
  const registry = await loadRegistry(personaDir);
  if (!registry.mcpServers[name])
    return { ok: false, detail: "not registered" };
  const vault = await openPersonaVault(personaDir);
  const hub = new McpHub(registry, vault);
  try {
    const tools = await Promise.race([
      hub.tools(name),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error(`no answer in ${Math.round(deadlineMs / 1000)}s`)),
          deadlineMs,
        ).unref?.(),
      ),
    ]);
    return { ok: true, tools: tools.length, detail: `${tools.length} tool(s)` };
  } catch (e) {
    // The client's errors are already actionable ("401 Unauthorized",
    // "command not found: uvx") — a wrapper sentence would bury them.
    return { ok: false, detail: (e as Error).message };
  } finally {
    await hub.close();
    vault.close();
  }
}

/**
 * Drop a server from the persona's registry.
 *
 * `purgeSecrets` also unsets the vault keys the entry referenced. Off by
 * default and asked for separately in the UI: the registry entry is
 * re-addable from notes, while the vault is the only copy of the credential.
 */
export async function deleteMcpServer(input: {
  personaDir: string;
  name: string;
  purgeSecrets?: boolean;
}): Promise<{ ok: boolean; purged: string[]; error?: string }> {
  const registry = await loadRegistry(input.personaDir);
  const entry = registry.mcpServers[input.name];
  const { registry: next, removed } = removeServer(registry, input.name);
  if (!removed)
    return { ok: false, purged: [], error: `no such MCP server: '${input.name}'` };
  await saveRegistry(input.personaDir, next);
  if (!input.purgeSecrets || !entry) return { ok: true, purged: [] };
  const keys = referencedVaultKeys(entry);
  if (keys.length === 0) return { ok: true, purged: [] };
  const vault = await openPersonaVault(input.personaDir);
  try {
    for (const key of keys) vault.unset(key);
  } finally {
    vault.close();
  }
  return { ok: true, purged: keys };
}
