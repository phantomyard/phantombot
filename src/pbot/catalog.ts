/**
 * One tool catalog behind every harness (issue #820): the `pbot_*` tools plus
 * every tool on the persona's registered MCP servers (e.g. Odoo), with ONE
 * loading rule.
 *
 *   - EAGER (in the initial tool list on every harness): `pbot_memory`,
 *     `pbot_vault`, and the discovery tool `pbot_tools`.
 *   - LAZY: every other `pbot_*` tool and every upstream server tool. The
 *     agent finds it with `pbot_tools {action:"search"}`, loads its schema with
 *     `{action:"describe"}`, and from then on it is a typed tool on that
 *     harness. `{action:"call"}` runs any catalog tool by name with the same
 *     validation, for a harness that cannot add tools mid-turn.
 *
 * Which tools are eager is the single list `EAGER_PBOT_TOOLS` — not a
 * per-harness decision. The claude/codex MCP proxy (src/mcp/proxy.ts) and the
 * embedded pi extension (src/pbot/piExtension.ts) both drive this class.
 *
 * Upstream tools are namespaced `<server>__<tool>`, the same ids the proxy and
 * `phantombot mcp search` have always used.
 */

import type { McpHub } from "../mcp/hub.ts";
import { qualify, splitQualified } from "../mcp/hub.ts";
import { PBOT_TOOLS, type PbotContext, type PbotTool } from "./tools.ts";

/** The eager core. `pbot_memory` must stay here: the memory reflex depends on it. */
export const EAGER_PBOT_TOOLS: readonly string[] = ["pbot_memory", "pbot_vault"];

import { PBOT_TOOLS_NAME } from "./env.ts";
export { PBOT_TOOLS_NAME };

/** A tool as a harness sees it: name, description, JSON schema. */
export interface CatalogToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type CatalogContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface CatalogResult {
  content: CatalogContent[];
  isError?: boolean;
  /**
   * An upstream MCP tool's `structuredContent`, carried through untouched so
   * the proxy hands MCP clients the complete result (PR #821 review).
   */
  structuredContent?: Record<string, unknown>;
}

export const PBOT_TOOLS_SCHEMA: CatalogToolSchema = {
  name: PBOT_TOOLS_NAME,
  description:
    "Discover and load the rest of your tools. Loaded from the start: pbot_memory, pbot_vault and this tool. " +
    "Everything else — pbot_task (scheduling), pbot_notify, pbot_browser, pbot_device (principal's PC), pbot_mcp (manage servers) " +
    "and every tool on a registered MCP server (named <server>__<tool>) — is found here. " +
    "search {query}: names + one-line summaries. describe {name}: full schema; the tool is then callable directly. " +
    "call {name, args}: run any tool by name (same validation).",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["search", "describe", "call"] },
      query: { type: "string", description: "search: keywords (empty lists everything)." },
      name: { type: "string", description: "describe/call: tool name, e.g. pbot_task or odoo__search_read." },
      args: { type: "object", description: "call: the tool's arguments." },
    },
    required: ["action"],
  },
};

function text(t: string, isError = false): CatalogResult {
  return isError ? { content: [{ type: "text", text: t }], isError: true } : { content: [{ type: "text", text: t }] };
}

function schemaOf(t: PbotTool): CatalogToolSchema {
  return { name: t.name, description: t.description, inputSchema: t.inputSchema };
}

/** Normalise an upstream MCP CallToolResult into catalog content. */
export function fromMcpResult(raw: unknown): CatalogResult {
  const r = (raw ?? {}) as { content?: unknown; isError?: unknown; structuredContent?: unknown };
  const content: CatalogContent[] = [];
  if (Array.isArray(r.content)) {
    for (const c of r.content as Array<Record<string, unknown>>) {
      if (c?.type === "text" && typeof c.text === "string") content.push({ type: "text", text: c.text });
      else if (c?.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string") {
        content.push({ type: "image", data: c.data, mimeType: c.mimeType });
      } else content.push({ type: "text", text: JSON.stringify(c) });
    }
  }
  const structured =
    r.structuredContent !== null && typeof r.structuredContent === "object" && !Array.isArray(r.structuredContent)
      ? (r.structuredContent as Record<string, unknown>)
      : undefined;
  if (structured !== undefined) {
    // A harness that reads only `content` (pi, and MCP clients that ignore
    // structuredContent) must still see the data: append its JSON unless a
    // text block already carries exactly that serialisation.
    const json = JSON.stringify(structured);
    if (!content.some((c) => c.type === "text" && c.text === json)) content.push({ type: "text", text: json });
  } else if (content.length === 0) {
    content.push({ type: "text", text: JSON.stringify(r.structuredContent ?? raw ?? null) });
  }
  const out: CatalogResult = { content };
  if (r.isError === true) out.isError = true;
  if (structured !== undefined) out.structuredContent = structured;
  return out;
}

export interface ToolCatalogOptions {
  ctx: PbotContext;
  /**
   * Upstream MCP servers. Opened lazily on first search/describe/call, so a
   * turn that never reaches for one costs nothing. Undefined = no upstream
   * (e.g. a test, or a persona with no registry).
   */
  hub?: () => Promise<McpHub | undefined>;
  /** Override the pbot tool set (tests). */
  tools?: readonly PbotTool[];
}

export class ToolCatalog {
  private readonly ctx: PbotContext;
  private readonly tools: readonly PbotTool[];
  private readonly hubFactory?: () => Promise<McpHub | undefined>;
  private hubPromise?: Promise<McpHub | undefined>;
  /** Lazy tools loaded this session via describe (pbot and upstream). */
  private readonly loaded = new Map<string, CatalogToolSchema>();

  constructor(opts: ToolCatalogOptions) {
    this.ctx = opts.ctx;
    this.tools = opts.tools ?? PBOT_TOOLS;
    this.hubFactory = opts.hub;
  }

  private hub(): Promise<McpHub | undefined> {
    if (!this.hubFactory) return Promise.resolve(undefined);
    this.hubPromise ??= this.hubFactory().catch(() => undefined);
    return this.hubPromise;
  }

  private pbot(name: string): PbotTool | undefined {
    return this.tools.find((t) => t.name === name);
  }

  /** The initial tool list every harness starts with. */
  initialTools(): CatalogToolSchema[] {
    const eager = this.tools.filter((t) => EAGER_PBOT_TOOLS.includes(t.name)).map(schemaOf);
    return [...eager, PBOT_TOOLS_SCHEMA];
  }

  /** Initial tools plus everything described so far (the proxy's live list). */
  activeTools(): CatalogToolSchema[] {
    return [...this.initialTools(), ...this.loaded.values()];
  }

  isLoaded(name: string): boolean {
    return EAGER_PBOT_TOOLS.includes(name) || name === PBOT_TOOLS_NAME || this.loaded.has(name);
  }

  async search(query: string): Promise<{ tools: Array<{ name: string; description: string }>; unreachable?: Record<string, string> }> {
    const q = query.trim().toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    const matches = (hay: string) => terms.length === 0 || terms.some((t) => hay.toLowerCase().includes(t));
    const out: Array<{ name: string; description: string }> = [];
    for (const t of this.tools) {
      if (matches(`${t.name} ${t.name.replace(/_/g, " ")} ${t.description}`)) {
        out.push({ name: t.name, description: t.description });
      }
    }
    const hub = await this.hub();
    let unreachable: Record<string, string> | undefined;
    if (hub) {
      // The hub's own search is a substring match on the WHOLE query; run it
      // per term so "odoo invoice" finds either word, like the pbot side.
      const seen = new Set<string>();
      for (const term of terms.length ? terms : [""]) {
        const { hits, errors } = await hub.search(term);
        for (const h of hits) {
          if (seen.has(h.qualifiedName)) continue;
          seen.add(h.qualifiedName);
          out.push({ name: h.qualifiedName, description: h.tool.description ?? "" });
        }
        if (Object.keys(errors).length) unreachable = { ...unreachable, ...errors };
      }
    }
    return unreachable ? { tools: out, unreachable } : { tools: out };
  }

  /** Full schema of one tool by name; marks it loaded for this session. */
  async describe(name: string): Promise<CatalogToolSchema> {
    const own = this.pbot(name);
    if (own) {
      const s = schemaOf(own);
      if (!this.isLoaded(name)) this.loaded.set(name, s);
      return s;
    }
    if (name === PBOT_TOOLS_NAME) return PBOT_TOOLS_SCHEMA;
    const split = splitQualified(name);
    const hub = await this.hub();
    if (!split || !hub) throw new Error(`unknown tool '${name}' — use pbot_tools search first`);
    const tools = await hub.tools(split.server);
    const tool = tools.find((t) => t.name === split.tool);
    if (!tool) throw new Error(`server '${split.server}' has no tool '${split.tool}'`);
    const s: CatalogToolSchema = {
      name: qualify(split.server, tool.name),
      description: `[${split.server} MCP server] ${tool.description ?? ""}`.trim(),
      inputSchema:
        tool.inputSchema && typeof tool.inputSchema === "object"
          ? (tool.inputSchema as Record<string, unknown>)
          : { type: "object", properties: {} },
    };
    this.loaded.set(s.name, s);
    return s;
  }

  /** Run any catalog tool by name (pbot_* or `<server>__<tool>`). */
  async call(name: string, args: Record<string, unknown>): Promise<CatalogResult> {
    if (name === PBOT_TOOLS_NAME) return this.callDiscovery(args);
    const own = this.pbot(name);
    if (own) {
      const r = await own.run(args ?? {}, this.ctx);
      return text(r.text, r.isError === true);
    }
    const split = splitQualified(name);
    const hub = await this.hub();
    if (!split || !hub) return text(`unknown tool '${name}' — use pbot_tools search first`, true);
    try {
      return fromMcpResult(await hub.call(split.server, split.tool, args ?? {}));
    } catch (e) {
      return text((e as Error).message, true);
    }
  }

  private async callDiscovery(args: Record<string, unknown>): Promise<CatalogResult> {
    const a = String(args.action ?? "");
    try {
      if (a === "search") return text(JSON.stringify(await this.search(String(args.query ?? "")), null, 2));
      if (a === "describe") {
        const name = String(args.name ?? "");
        if (!name) return text("describe needs 'name'", true);
        return text(JSON.stringify(await this.describe(name), null, 2));
      }
      if (a === "call") {
        const name = String(args.name ?? "");
        if (!name || name === PBOT_TOOLS_NAME) return text("call needs the 'name' of another tool", true);
        const inner = (args.args ?? {}) as Record<string, unknown>;
        if (typeof inner !== "object" || Array.isArray(inner)) return text("'args' must be an object", true);
        return this.call(name, inner);
      }
      return text("'action' must be one of: search, describe, call", true);
    } catch (e) {
      return text((e as Error).message, true);
    }
  }

  async close(): Promise<void> {
    const hub = this.hubPromise ? await this.hubPromise : undefined;
    await hub?.close();
  }
}
