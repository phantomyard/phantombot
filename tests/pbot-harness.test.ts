/**
 * #820 harness wiring: the harness-gated prompt rewrite (memory reflex
 * included), the pi adapter's eager/lazy registration, codex's proxy
 * overrides and which spawns carry the tools.
 */

import { describe, expect, test } from "bun:test";

import {
  BROWSER_TOOLS_SECTION,
  buildMcpToolsSection,
  CREDENTIALS_SECTION,
  DEVICE_TOOLS_SECTION,
  MEMORY_TOOLS_SECTION,
  NOTIFICATION_SECTION,
  SCHEDULING_TOOLS_SECTION,
  WORKSPACE_LOCK_SECTION,
} from "../src/persona/builder.ts";
import {
  adaptPromptForPbotTools,
  adaptRequestForPbotTools,
  PBOT_MEMORY_SECTION,
} from "../src/persona/pbotPrompt.ts";
import { CAPTURE_NUDGE_TEXT } from "../src/channels/core/prompts.ts";
import { codexGetsPbotTools, codexProxyOverrides } from "../src/harnesses/codex.ts";
import { PiHarness } from "../src/harnesses/pi.ts";
import type { HarnessRequest } from "../src/harnesses/types.ts";
import { EAGER_PBOT_TOOLS, ToolCatalog } from "../src/pbot/catalog.ts";
import { pbotToolsEnabled, registerCatalogOnPi, type PbotPiApi } from "../src/pbot/piExtension.ts";
import type { PbotTool } from "../src/pbot/tools.ts";

const PROMPT = [
  "# Identity\n\nrobbie",
  MEMORY_TOOLS_SECTION,
  SCHEDULING_TOOLS_SECTION,
  buildMcpToolsSection(["odoo", "github"]),
  BROWSER_TOOLS_SECTION,
  DEVICE_TOOLS_SECTION,
  NOTIFICATION_SECTION,
  WORKSPACE_LOCK_SECTION,
  CREDENTIALS_SECTION,
  "# Security perimeter — TRUSTED turn\n\nok",
  CAPTURE_NUDGE_TEXT,
].join("\n\n");

describe("adaptPromptForPbotTools", () => {
  test("without tools the prompt is byte-identical", () => {
    expect(adaptPromptForPbotTools(PROMPT, false)).toBe(PROMPT);
  });

  test("with tools no CLI route for a tooled capability is documented", () => {
    const p = adaptPromptForPbotTools(PROMPT, true);
    for (const cli of [
      "phantombot memory search",
      "phantombot memory capture",
      "phantombot task add",
      "phantombot mcp search",
      "phantombot mcp call",
      "phantombot browser open",
      "phantombot device call",
      "phantombot notify --message",
      "phantombot vault set",
      "phantombot vault get",
    ]) {
      expect(p).not.toContain(cli);
    }
  });

  test("the memory reflex names pbot_memory, and the eager overview is present", () => {
    const p = adaptPromptForPbotTools(PROMPT, true);
    expect(p).toContain('call `pbot_memory` {action:"search", query:"<topic>"} FIRST');
    expect(p).toContain('pbot_memory {action:"capture", text:"<the thing worth keeping>", tags:["<tag>"]}');
    expect(p).toContain("# Your phantombot tools");
    for (const t of ["pbot_memory", "pbot_vault", "pbot_tools"]) expect(p).toContain(t);
  });

  test("the reflex keeps the CLI wording on a harness without the tool", () => {
    expect(adaptPromptForPbotTools(PROMPT, false)).toContain('run `phantombot memory search "<topic>"` FIRST');
  });

  test("the capture nudge follows the tool", () => {
    const p = adaptPromptForPbotTools(PROMPT, true);
    expect(p).toContain("capture it now with `pbot_memory capture`");
  });

  test("tool sections keep intentional CLI wording for command-task scripts", () => {
    const p = adaptPromptForPbotTools(PROMPT, true);
    expect(p).toContain("the script calls `phantombot ask`");
    expect(p).toContain("`phantombot notify` only when something genuinely");
  });

  test("sections with no tool (workspace lock, identity, perimeter) are untouched", () => {
    const p = adaptPromptForPbotTools(PROMPT, true);
    expect(p).toContain(WORKSPACE_LOCK_SECTION);
    expect(p.startsWith("# Identity\n\nrobbie")).toBe(true);
    expect(p).toContain("# Security perimeter — TRUSTED turn\n\nok");
  });

  test("the credentials section steers commands to pbot_vault exec", () => {
    const p = adaptPromptForPbotTools(PROMPT, true);
    expect(p).toContain('pbot_vault {action:"exec"');
  });

  test("the memory body (drawers, journal, OKF rules) survives the rewrite", () => {
    expect(PBOT_MEMORY_SECTION).toContain("THE FIVE DRAWERS ARE ROWS, NOT FILES.");
    expect(PBOT_MEMORY_SECTION).toContain("OKF FRONTMATTER");
    expect(PBOT_MEMORY_SECTION).toContain("The heartbeat is mechanical (no LLM).");
  });

  test("turnContext (standing memory, journal footer) is rewritten too", () => {
    const req = { systemPrompt: "x", turnContext: "`phantombot memory search \"<terms>\"` finds the rest" };
    expect(adaptRequestForPbotTools(req, true).turnContext).toContain("`pbot_memory search");
    expect(adaptRequestForPbotTools(req, false)).toBe(req);
  });
});

describe("pbot_memory stays eager (the reflex depends on it)", () => {
  test("eager list", () => {
    expect(EAGER_PBOT_TOOLS).toContain("pbot_memory");
    expect(EAGER_PBOT_TOOLS).toContain("pbot_vault");
  });
});

// ---------------------------------------------------------------------------

function fakeTool(name: string, reply = "ok"): PbotTool {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: { action: { type: "string" } }, required: ["action"] },
    run: async (args) => ({ text: `${name}:${reply}:${JSON.stringify(args)}` }),
  };
}

function fakePi() {
  const tools = new Map<string, Parameters<PbotPiApi["registerTool"]>[0]>();
  const api: PbotPiApi = { registerTool: (t) => void tools.set(t.name, t) };
  return { api, tools };
}

describe("pi adapter", () => {
  const catalog = () =>
    new ToolCatalog({
      ctx: { env: {} },
      tools: [fakeTool("pbot_memory"), fakeTool("pbot_vault"), fakeTool("pbot_task")],
    });

  test("registers only the eager core at load", () => {
    const { api, tools } = fakePi();
    registerCatalogOnPi(api, catalog());
    expect([...tools.keys()].sort()).toEqual(["pbot_memory", "pbot_tools", "pbot_vault"]);
  });

  test("describe registers the lazy tool natively, which then runs in-process", async () => {
    const { api, tools } = fakePi();
    registerCatalogOnPi(api, catalog());
    await tools.get("pbot_tools")!.execute("1", { action: "describe", name: "pbot_task" });
    expect(tools.has("pbot_task")).toBe(true);
    const r = await tools.get("pbot_task")!.execute("2", { action: "list" });
    expect(r.content[0]).toEqual({ type: "text", text: 'pbot_task:ok:{"action":"list"}' });
  });

  test("pbot_tools call reaches a lazy tool without describe", async () => {
    const { api, tools } = fakePi();
    registerCatalogOnPi(api, catalog());
    const r = await tools.get("pbot_tools")!.execute("1", { action: "call", name: "pbot_task", args: { action: "list" } });
    expect((r.content[0] as { text: string }).text).toContain("pbot_task:ok");
    expect(r.isError).toBeUndefined();
  });

  test("enabled only when the harness set the flag and no security session is live", () => {
    expect(pbotToolsEnabled({})).toBe(false);
    expect(pbotToolsEnabled({ PHANTOMBOT_PBOT_TOOLS: "1" })).toBe(true);
    expect(pbotToolsEnabled({ PHANTOMBOT_PBOT_TOOLS: "1", PHANTOMBOT_SECURITY_SESSION: "{}" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------

const baseReq = { systemPrompt: "", userMessage: "hi", history: [] } as unknown as HarnessRequest;

describe("which spawns carry the tools", () => {
  test("native pi: foreground yes; judge, background, sandboxed no", () => {
    const native = new PiHarness({ mode: "native", bin: "pi" } as never);
    expect(native.pbotToolsFor(baseReq)).toBe(true);
    expect(native.pbotToolsFor({ ...baseReq, toolsMode: "none" })).toBe(false);
    expect(native.pbotToolsFor({ ...baseReq, mcpMode: "none" })).toBe(false);
    expect(native.pbotToolsFor({ ...baseReq, securitySession: {} as never })).toBe(false);
  });

  test("host pi never (it cannot load phantombot code)", () => {
    const host = new PiHarness({ mode: "host", bin: "pi" } as never);
    expect(host.pbotToolsFor(baseReq)).toBe(false);
  });

  test("codex: foreground yes; judge, background, sandboxed no", () => {
    expect(codexGetsPbotTools(baseReq)).toBe(true);
    expect(codexGetsPbotTools({ ...baseReq, toolsMode: "none" })).toBe(false);
    expect(codexGetsPbotTools({ ...baseReq, mcpMode: "none" })).toBe(false);
    expect(codexGetsPbotTools({ ...baseReq, securitySession: {} as never })).toBe(false);
  });
});

describe("codexProxyOverrides", () => {
  test("translates the proxy config into -c mcp_servers.phantombot.* TOML overrides", () => {
    const cfg = JSON.stringify({
      mcpServers: {
        phantombot: {
          command: "/usr/bin/phantombot",
          args: ["mcp", "proxy", "--persona", "lena"],
          env: { PHANTOMBOT_PERSONA: "lena", PHANTOMBOT_CONVERSATION: 'tg:"1"' },
        },
      },
    });
    expect(codexProxyOverrides(cfg)).toEqual([
      "-c", 'mcp_servers.phantombot.command="/usr/bin/phantombot"',
      "-c", 'mcp_servers.phantombot.args=["mcp","proxy","--persona","lena"]',
      "-c", 'mcp_servers.phantombot.env={PHANTOMBOT_PERSONA="lena", PHANTOMBOT_CONVERSATION="tg:\\"1\\""}',
    ]);
  });

  test("empty or broken config = no overrides", () => {
    expect(codexProxyOverrides('{"mcpServers":{}}')).toEqual([]);
    expect(codexProxyOverrides("not json")).toEqual([]);
  });
});
