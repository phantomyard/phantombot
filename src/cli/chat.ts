/**
 * `phantombot chat` — the channel-configuration namespace.
 *
 *   chat telegram   — configure the Telegram channel (the former
 *                     `phantombot telegram`, now living here).
 *   chat matrix     — configure the Matrix channel (homeserver/user/password;
 *                     E2EE set up automatically).
 *   chat default    — set which channel carries UNSOLICITED traffic (proactive
 *                     notify, briefings, task fires, and the security-hold
 *                     grounding write). Replies always go back on the inbound
 *                     channel regardless; this governs outbound-without-inbound.
 *
 * `phantombot telegram` is kept as a thin DEPRECATED ALIAS that forwards to
 * `chat telegram` (see cli/telegram.ts) so existing muscle memory + docs keep
 * working through the rename.
 */

import { defineCommand } from "citty";
import * as p from "@clack/prompts";

import {
  type Config,
  type DefaultChannel,
  loadConfig,
  resolveDefaultChannel,
} from "../config.ts";
import { setIn, updateConfigToml } from "../lib/configWriter.ts";
import type { WriteSink } from "../lib/io.ts";
import { defaultServiceControl, type ServiceControl } from "../lib/platform.ts";
import { maybePromptRestart } from "./harness.ts";
import telegramCmd from "./telegram.ts";
import matrixCmd from "./chat-matrix.ts";

/**
 * Persist `default_channel` into the `[chat]` block of config.toml. Pure side
 * effect; preserves other sections (modulo smol-toml reformatting).
 */
export async function applyDefaultChannel(
  configPath: string,
  channel: DefaultChannel,
): Promise<void> {
  await updateConfigToml(configPath, (toml) => {
    setIn(toml, ["chat", "default_channel"], channel);
  });
}

export interface RunChatDefaultInput {
  config?: Config;
  /** When provided, set non-interactively; otherwise prompt. */
  channel?: DefaultChannel;
  serviceControl?: ServiceControl;
  out?: WriteSink;
  err?: WriteSink;
}

export async function runChatDefault(
  input: RunChatDefaultInput = {},
): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const config = input.config ?? (await loadConfig());
  const svc = input.serviceControl ?? defaultServiceControl();

  let channel = input.channel;
  if (channel === undefined) {
    const current = resolveDefaultChannel(config);
    const picked = await p.select<DefaultChannel>({
      message: "Which channel should carry proactive/unsolicited messages?",
      options: [
        { value: "telegram", label: `Telegram${current === "telegram" ? " (current)" : ""}` },
        { value: "matrix", label: `Matrix${current === "matrix" ? " (current)" : ""}` },
      ],
      initialValue: current,
    });
    if (p.isCancel(picked)) {
      p.cancel("cancelled");
      return 1;
    }
    channel = picked;
  }

  if (channel !== "telegram" && channel !== "matrix") {
    err.write(`unknown channel '${channel}' — expected telegram or matrix.\n`);
    return 2;
  }

  await applyDefaultChannel(config.configPath, channel);
  out.write(`default_channel set to ${channel} (saved to ${config.configPath})\n`);
  await maybePromptRestart(svc);
  return 0;
}

const defaultCmd = defineCommand({
  meta: {
    name: "default",
    description:
      "Set the channel for unsolicited/proactive messages (telegram|matrix). Replies always go back on the inbound channel.",
  },
  args: {
    channel: {
      type: "positional",
      required: false,
      description: "telegram | matrix (omit to choose interactively)",
    },
  },
  async run({ args }) {
    const raw = args.channel as string | undefined;
    if (raw !== undefined && raw !== "telegram" && raw !== "matrix") {
      process.stderr.write(
        `unknown channel '${raw}' — expected telegram or matrix.\n`,
      );
      process.exitCode = 2;
      return;
    }
    process.exitCode = await runChatDefault({
      channel: raw as DefaultChannel | undefined,
    });
  },
});

export default defineCommand({
  meta: {
    name: "chat",
    description:
      "Configure chat channels: `chat telegram`, `chat matrix`, `chat default <telegram|matrix>`.",
  },
  subCommands: {
    telegram: telegramCmd,
    matrix: matrixCmd,
    default: defaultCmd,
  },
});
