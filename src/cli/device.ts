/**
 * `phantombot device` — run tools on the principal's PC through the
 * PhantomChat desktop app (issue #747). Protocol and trust model:
 * src/channels/phantomchat/localTools.ts.
 *
 *   phantombot device list                      # which of the principal's PCs are online
 *   phantombot device call <device> <tool> --args '{"command":"ls"}'
 *
 * A device shows up only while the app is running and the principal has
 * turned this persona's "Local tools" switch ON on that PC. Silence = no
 * device. Called from a PhantomChat group turn, the call carries that group's
 * id (from PHANTOMBOT_CONVERSATION) and the app runs it only in a Session with
 * this persona.
 *
 * Trusted tier only: an escorted or otherwise untrusted turn is refused here,
 * on top of the perimeter that already screens what such a turn may run.
 */

import { defineCommand } from "citty";

import { type Config, loadConfig, personaDir } from "../config.ts";
import { loadPhantomchatPersonaConfig } from "../channels/phantomchat/personaStore.ts";
import {
  type DeviceCapability,
  findDevice,
  groupIdForConversation,
  LOCAL_TOOL_ARGS,
  LOCAL_TOOLS,
  LocalToolsClient,
  type LocalToolsPool,
  MAX_CALL_MS,
  type ToolResult,
} from "../channels/phantomchat/localTools.ts";
import { npubEncode } from "../lib/nostrIdentity.ts";

export const EXIT_UNAVAILABLE = 3;

export interface DeviceRunInput {
  persona?: string;
  /** Test seam: the loaded config. */
  config?: Config;
  /** Seconds to wait for devices to answer hello. */
  waitS?: number;
  json?: boolean;
  env?: NodeJS.ProcessEnv;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Test seam: the relay pool. Default AuthGuardedSimplePool as the persona. */
  makePool?: (secretKey: Uint8Array) => LocalToolsPool | Promise<LocalToolsPool>;
  signal?: AbortSignal;
  /** Test seam: extra wait after the call's own timeout. */
  graceMs?: number;
}

/** Why this turn may not use the principal's PC, or undefined when it may. */
export function untrustedReason(env: NodeJS.ProcessEnv): string | undefined {
  if (env.PHANTOMBOT_ESCORT) return "this is an escorted (untrusted) turn";
  const scratch = env.PHANTOMBOT_SCRATCH ?? "";
  if (/[\\/]scratch[\\/]untrusted[\\/]/.test(scratch)) return "this is an untrusted turn";
  return undefined;
}

async function openClient(input: DeviceRunInput): Promise<LocalToolsClient | string> {
  const env = input.env ?? process.env;
  const why = untrustedReason(env);
  if (why) return `refused: ${why}; the principal's PC is for trusted turns only`;
  const config = input.config ?? (await loadConfig());
  const persona = input.persona || env.PHANTOMBOT_PERSONA || config.defaultPersona;
  const pc = loadPhantomchatPersonaConfig(personaDir(config, persona));
  if (!pc) return `persona '${persona}' has no PhantomChat channel (no phantomchat.json)`;
  if (pc.allowedHex.length === 0) return `persona '${persona}' has no allowed principal npub`;
  const pool = input.makePool
    ? await input.makePool(pc.identity.secretKey)
    : await defaultPool(pc.identity.secretKey);
  return new LocalToolsClient({
    secretKey: pc.identity.secretKey,
    publicKeyHex: pc.identity.publicKeyHex,
    relays: pc.relays,
    principalsHex: pc.allowedHex,
    pool,
  });
}

async function defaultPool(secretKey: Uint8Array): Promise<LocalToolsPool> {
  const { AuthGuardedSimplePool } = await import("../channels/phantomchat/authGuardedPool.ts");
  return new AuthGuardedSimplePool(secretKey) as unknown as LocalToolsPool;
}

function describeDevice(d: DeviceCapability): Record<string, unknown> {
  return {
    device: d.deviceId,
    name: d.deviceName,
    platform: d.platform,
    tools: d.tools,
    owner: npubEncode(d.ownerHex),
  };
}

export async function runDeviceList(input: DeviceRunInput): Promise<number> {
  const out = input.out ?? ((s) => process.stdout.write(s));
  const err = input.err ?? ((s) => process.stderr.write(s));
  const client = await openClient(input);
  if (typeof client === "string") {
    err(`${client}\n`);
    return 1;
  }
  try {
    const devices = await client.discover((input.waitS ?? 5) * 1000);
    if (input.json) {
      out(`${JSON.stringify({ devices: devices.map(describeDevice) }, null, 2)}\n`);
    } else if (devices.length === 0) {
      out("no devices online (the app isn't running, or Local tools is OFF for this contact)\n");
    } else {
      for (const d of devices) {
        out(`${d.deviceName || "(unnamed)"}  ${d.deviceId}  ${d.platform}  tools: ${d.tools.join(", ")}\n`);
      }
    }
    return 0;
  } finally {
    client.close();
  }
}

export function exitCodeFor(r: ToolResult): number {
  switch (r.status) {
    case "ok":
      return typeof r.exit === "number" ? Math.max(0, Math.min(125, Math.trunc(r.exit))) : 0;
    case "cancelled":
      return 130;
    case "timeout":
      return EXIT_UNAVAILABLE;
    default:
      return 1;
  }
}

export async function runDeviceCall(
  input: DeviceRunInput & { device: string; tool: string; args: string; timeoutS?: number; group?: string },
): Promise<number> {
  const out = input.out ?? ((s) => process.stdout.write(s));
  const err = input.err ?? ((s) => process.stderr.write(s));
  let args: unknown;
  try {
    args = JSON.parse(input.args);
  } catch {
    err(`--args must be JSON, e.g. '{"command":"ls"}'\n`);
    return 1;
  }
  const timeoutMs = input.timeoutS === undefined ? undefined : Math.round(input.timeoutS * 1000);
  if (timeoutMs !== undefined && (!(timeoutMs >= 1) || timeoutMs > MAX_CALL_MS)) {
    err(`--timeout must be 1 .. ${MAX_CALL_MS / 1000} seconds\n`);
    return 1;
  }
  const client = await openClient(input);
  if (typeof client === "string") {
    err(`${client}\n`);
    return 1;
  }
  try {
    const devices = await client.discover((input.waitS ?? 8) * 1000, input.device);
    const device = findDevice(devices, input.device);
    if (!device) {
      const online = devices.map((d) => d.deviceName || d.deviceId).join(", ") || "none";
      err(`device '${input.device}' is not available (online: ${online})\n`);
      return EXIT_UNAVAILABLE;
    }
    const env = input.env ?? process.env;
    const groupId = input.group || groupIdForConversation(env.PHANTOMBOT_CONVERSATION);
    let result: ToolResult;
    try {
      result = await client.call(device, input.tool, args, {
        timeoutMs,
        groupId,
        graceMs: input.graceMs,
        signal: input.signal,
      });
    } catch (e) {
      err(`${(e as Error).message}\n`);
      return 1;
    }
    if (input.json) {
      out(`${JSON.stringify(result)}\n`);
    } else {
      if (result.output) out(result.output.endsWith("\n") ? result.output : `${result.output}\n`);
      if (result.status !== "ok" || (result.exit ?? 0) !== 0 || result.truncated) {
        const exit = result.exit === undefined ? "" : ` exit=${result.exit}`;
        err(`[${result.status}${exit}${result.truncated ? " truncated" : ""}]\n`);
      }
    }
    return exitCodeFor(result);
  } finally {
    client.close();
  }
}

const PERSONA_HELP = "Persona (default PHANTOMBOT_PERSONA, then the default persona).";

export default defineCommand({
  meta: {
    name: "device",
    description:
      "Run tools on your principal's PC via the PhantomChat desktop app (needs Local tools ON for this persona there).",
  },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "List the principal's PCs that are online and lending tools." },
      args: {
        persona: { type: "string", description: PERSONA_HELP },
        json: { type: "boolean", description: "Machine-readable output." },
        wait: { type: "string", description: "Seconds to wait for answers (default 5)." },
      },
      async run({ args }) {
        process.exitCode = await runDeviceList({
          persona: args.persona as string | undefined,
          json: Boolean(args.json),
          waitS: args.wait === undefined ? undefined : Number(args.wait),
        });
      },
    }),
    call: defineCommand({
      meta: {
        name: "call",
        description: `Run one tool on a device. Tools: ${LOCAL_TOOLS.join(", ")}. Exit 3 = device unavailable.`,
      },
      args: {
        device: { type: "positional", required: true, description: "Device name or id (from `device list`)." },
        tool: { type: "positional", required: true, description: LOCAL_TOOLS.join(" | ") },
        args: {
          type: "string",
          required: true,
          description: `The tool's arguments as JSON. ${LOCAL_TOOLS.map((t) => `${t} ${LOCAL_TOOL_ARGS[t]}`).join("; ")}.`,
        },
        timeout: { type: "string", description: "Seconds the tool may run (default 120, max 600)." },
        group: {
          type: "string",
          description: "PhantomChat group id (default: from PHANTOMBOT_CONVERSATION).",
        },
        wait: { type: "string", description: "Seconds to wait for the device to answer (default 8)." },
        persona: { type: "string", description: PERSONA_HELP },
        json: { type: "boolean", description: "Print the full result as JSON." },
      },
      async run({ args }) {
        const controller = new AbortController();
        const onInt = () => controller.abort();
        process.once("SIGINT", onInt);
        process.once("SIGTERM", onInt);
        try {
          process.exitCode = await runDeviceCall({
            persona: args.persona as string | undefined,
            json: Boolean(args.json),
            device: String(args.device),
            tool: String(args.tool),
            args: String(args.args),
            timeoutS: args.timeout === undefined ? undefined : Number(args.timeout),
            group: args.group as string | undefined,
            waitS: args.wait === undefined ? undefined : Number(args.wait),
            signal: controller.signal,
          });
        } finally {
          process.off("SIGINT", onInt);
          process.off("SIGTERM", onInt);
        }
      },
    }),
  },
});
