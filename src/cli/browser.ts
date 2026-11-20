import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, personaDir, resolvePersona, type Config } from "../config.ts";
import { browserCall } from "../browser/daemon.ts";
import { BROWSER_ACTIONS, type BrowserRequest, validateRequest } from "../browser/session.ts";
import { invokeSession, sessionFromEnv } from "../security/extension.ts";
import { ENV_SECURITY_SESSION } from "../security/session.ts";

export async function browserRoot(persona?: string, config?: Config, env = process.env): Promise<string> {
  // Untrusted turns never connect to persistent, authenticated host sessions.
  // The OS sandbox already limits them to this runtime-owned scratch directory.
  if ((env.PHANTOMBOT_TURN_ID || env.PHANTOMBOT_CONVERSATION) && env.PHANTOMBOT_TRUSTED !== "1") {
    throw new Error("Sandboxed browsers require the runtime broker; Chrome cannot run inside the OS sandbox");
  }
  const c = config ?? await loadConfig();
  const name = persona || env.PHANTOMBOT_PERSONA || resolvePersona(undefined, c);
  if (!/^[a-zA-Z0-9_-]+$/.test(name) || !existsSync(personaDir(c, name))) throw new Error(`Persona '${name}' does not exist`);
  return join(personaDir(c, name), "browser");
}

export interface BrowserInput {
  request: BrowserRequest;
  persona?: string;
  config?: Config;
  env?: NodeJS.ProcessEnv;
  call?: typeof browserCall;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

export async function runBrowser(input: BrowserInput): Promise<number> {
  try {
    validateRequest(input.request);
    const request = { ...input.request };
    const env = input.env ?? process.env;
    // Tabs are conversation-scoped by default; cookies remain persona-scoped.
    const conversation = env.PHANTOMBOT_CONVERSATION;
    if (!request.session && conversation) request.session = new Bun.CryptoHasher("sha256").update(conversation).digest("hex");
    let result: unknown;
    if (env[ENV_SECURITY_SESSION] !== undefined || ((env.PHANTOMBOT_TURN_ID || env.PHANTOMBOT_CONVERSATION) && env.PHANTOMBOT_TRUSTED !== "1")) {
      if (input.persona && input.persona !== env.PHANTOMBOT_PERSONA) throw new Error("Cannot select another persona from a sandboxed turn");
      const session = sessionFromEnv(env);
      if (!session) throw new Error("Sandboxed browsers require a live runtime broker session");
      const response = await invokeSession(session, { kind: "broker", operation: { kind: "browser", request } }, AbortSignal.timeout(40_000));
      const body = JSON.parse(response.text) as { result?: unknown; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Browser broker refused the operation");
      result = body.result;
    } else {
      const root = await browserRoot(input.persona, input.config, env);
      result = await (input.call ?? browserCall)(root, request);
    }
    (input.out ?? (s => process.stdout.write(s)))(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    (input.err ?? (s => process.stderr.write(s)))(`browser: ${(error as Error).message}\n`);
    return 1;
  }
}

export default defineCommand({
  meta: { name: "browser", description: "Browse rendered pages with Chrome: text, screenshots, clicks and typing via Bun.WebView." },
  args: {
    action: { type: "positional", required: true, description: BROWSER_ACTIONS.join(" | ") },
    value: { type: "positional", required: false, description: "URL for open, CSS selector for click, text for type, key for press." },
    session: { type: "string", description: "Tab name (default: current conversation, or default in a terminal)." },
    "user-agent": { type: "string", description: "User agent for open; retained per tab. Empty string resets to installed Chrome." },
    persona: { type: "string", description: "Persona (default PHANTOMBOT_PERSONA, then configured default)." },
    dx: { type: "string", description: "Horizontal scroll in pixels (default 0)." },
    dy: { type: "string", description: "Vertical scroll in pixels." },
    width: { type: "string", description: "Viewport width for resize (1..4096)." },
    height: { type: "string", description: "Viewport height for resize (1..4096)." },
  },
  async run({ args }) {
    const action = String(args.action) as BrowserRequest["action"];
    process.exitCode = await runBrowser({
      persona: args.persona,
      request: {
        action, session: args.session,
        ...(args["user-agent"] !== undefined ? { userAgent: args["user-agent"] || null } : {}),
        ...(action === "open" ? { url: args.value } : {}),
        ...(action === "click" ? { selector: args.value } : {}),
        ...(action === "type" ? { text: args.value } : {}),
        ...(action === "press" ? { key: args.value } : {}),
        ...(args.dx !== undefined ? { dx: Number(args.dx) } : {}),
        ...(args.dy !== undefined ? { dy: Number(args.dy) } : {}),
        ...(args.width !== undefined ? { width: Number(args.width) } : {}),
        ...(args.height !== undefined ? { height: Number(args.height) } : {}),
      },
    });
  },
});
