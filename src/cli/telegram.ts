/**
 * `phantombot telegram` — interactive TUI to configure the Telegram channel.
 *
 * Asks for the bot token, validates it via `getMe`, asks for allowed
 * Telegram user IDs, and writes the [channels.telegram] block in
 * config.toml. Other sections of the config are preserved (modulo
 * smol-toml's stringify reformatting; comments are NOT preserved — see
 * src/lib/configWriter.ts).
 */

import { defineCommand } from "citty";
import * as p from "@clack/prompts";

import { type Config, loadConfig } from "../config.ts";
import { setIn, updateConfigToml } from "../lib/configWriter.ts";
import { defaultServiceControl, type ServiceControl } from "../lib/systemd.ts";
import { telegramGetMe, type GetMeResult } from "../lib/telegramApi.ts";
import type { WriteSink } from "../lib/io.ts";
import { maybePromptRestart } from "./harness.ts";

export interface TelegramTuiInputs {
  token: string;
  pollTimeoutS: number;
  allowedUserIds: number[];
}

/**
 * Write the supplied inputs to the [channels.telegram] block of the
 * config file, preserving other sections. Pure side effect.
 */
export async function applyTelegramConfig(
  configPath: string,
  inputs: TelegramTuiInputs,
): Promise<void> {
  await updateConfigToml(configPath, (toml) => {
    setIn(toml, ["channels", "telegram", "token"], inputs.token);
    setIn(
      toml,
      ["channels", "telegram", "poll_timeout_s"],
      inputs.pollTimeoutS,
    );
    setIn(
      toml,
      ["channels", "telegram", "allowed_user_ids"],
      inputs.allowedUserIds,
    );
  });
}

export function parseAllowedUserIds(raw: string): number[] {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
}

interface RunInput {
  config?: Config;
  /** Override the validator for testing. */
  validateToken?: (token: string) => Promise<GetMeResult>;
  serviceControl?: ServiceControl;
  out?: WriteSink;
}

export async function runTelegram(input: RunInput = {}): Promise<number> {
  const config = input.config ?? (await loadConfig());
  const validate = input.validateToken ?? telegramGetMe;
  const svc = input.serviceControl ?? defaultServiceControl();

  p.intro("Configure the Telegram channel");

  const existing = config.channels.telegram;
  if (existing?.token) {
    p.note(
      `Token: ${maskToken(existing.token)}\n` +
        `Allowed users: ${existing.allowedUserIds.length === 0 ? "(any)" : existing.allowedUserIds.join(", ")}\n` +
        `Long-poll timeout: ${existing.pollTimeoutS}s`,
      "Existing config",
    );

    const action = await p.select<"replace" | "users" | "cancel">({
      message: "What do you want to do?",
      options: [
        { value: "replace", label: "Replace token + allowed users" },
        { value: "users", label: "Update allowed users only (keep token)" },
        { value: "cancel", label: "Cancel — leave config unchanged" },
      ],
    });
    if (p.isCancel(action) || action === "cancel") {
      p.cancel("cancelled");
      return 0;
    }
    if (action === "users") {
      return updateAllowedUsersOnly(config, existing.token, svc);
    }
    // fallthrough to replace flow
  }

  const token = await p.password({
    message: "Telegram bot token (from @BotFather)",
    validate: (v) => {
      if (!v || v.length === 0) return "token is required";
      if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(v))
        return "doesn't look like a Telegram bot token (NNNNN:XXXXXXX...)";
      return undefined;
    },
  });
  if (p.isCancel(token)) {
    p.cancel("cancelled");
    return 1;
  }

  const spinner = p.spinner();
  spinner.start("validating token via getMe…");
  const me = await validate(token as string);
  if (!me.ok) {
    spinner.stop(`token rejected: ${me.error}`);
    p.cancel("aborting — token did not validate");
    return 1;
  }
  spinner.stop(`bot validated: @${me.username} (id ${me.id})`);

  const currentAllowed =
    config.channels.telegram?.allowedUserIds.join(", ") ?? "";
  const allowedRaw = await p.text({
    message:
      "Allowed Telegram user IDs (comma-separated; empty = anyone, with a warning)",
    placeholder: "123456789",
    defaultValue: currentAllowed,
  });
  if (p.isCancel(allowedRaw)) {
    p.cancel("cancelled");
    return 1;
  }
  const allowedUserIds = parseAllowedUserIds(allowedRaw as string);
  if (allowedUserIds.length === 0) {
    const proceed = await p.confirm({
      message:
        "No allowlist set — anyone who DMs the bot will be answered. Proceed?",
      initialValue: false,
    });
    if (p.isCancel(proceed) || !proceed) {
      p.cancel("cancelled");
      return 1;
    }
  }

  await applyTelegramConfig(config.configPath, {
    token: token as string,
    pollTimeoutS: 30,
    allowedUserIds,
  });
  p.note(
    `bot: @${me.username}\n` +
      `allowed users: ${
        allowedUserIds.length === 0 ? "(any)" : allowedUserIds.join(", ")
      }\n` +
      `saved to ${config.configPath}`,
    "Saved",
  );

  await maybePromptRestart(svc);

  p.outro("done");
  return 0;
}

async function updateAllowedUsersOnly(
  config: Config,
  existingToken: string,
  svc: ServiceControl,
): Promise<number> {
  const currentAllowed =
    config.channels.telegram?.allowedUserIds.join(", ") ?? "";
  const allowedRaw = await p.text({
    message:
      "Allowed Telegram user IDs (comma-separated; empty = anyone, with a warning)",
    placeholder: "123456789",
    defaultValue: currentAllowed,
  });
  if (p.isCancel(allowedRaw)) {
    p.cancel("cancelled");
    return 0;
  }
  const allowedUserIds = parseAllowedUserIds(allowedRaw as string);
  if (allowedUserIds.length === 0) {
    const proceed = await p.confirm({
      message:
        "No allowlist set — anyone who DMs the bot will be answered. Proceed?",
      initialValue: false,
    });
    if (p.isCancel(proceed) || !proceed) {
      p.cancel("cancelled");
      return 0;
    }
  }
  await applyTelegramConfig(config.configPath, {
    token: existingToken,
    pollTimeoutS: 30,
    allowedUserIds,
  });
  p.note(
    `allowed users: ${allowedUserIds.length === 0 ? "(any)" : allowedUserIds.join(", ")}\n` +
      `saved to ${config.configPath}`,
    "Saved",
  );
  await maybePromptRestart(svc);
  p.outro("done");
  return 0;
}

function maskToken(t: string): string {
  if (t.length <= 12) return "***";
  return t.slice(0, 6) + "…" + t.slice(-4);
}

// Re-export for tests / programmatic use.
export { telegramGetMe } from "../lib/telegramApi.ts";

// Used by import-persona.ts for the OpenClaw-config sniff.
export interface OpenClawTelegramSnippet {
  token: string;
  allowedUserIds: number[];
}

/**
 * Pull the Telegram bot config out of an OpenClaw `openclaw.json`. Returns
 * undefined if the file is unreadable, malformed, or has no telegram block.
 *
 * Looks for: channels.telegram.accounts.default.botToken (modern layout)
 *      and:  channels.telegram.botToken               (older flat layout)
 */
export function parseOpenClawTelegram(
  openclawJson: unknown,
): OpenClawTelegramSnippet | undefined {
  const json = openclawJson as Record<string, unknown> | undefined;
  if (!json) return undefined;

  const tg = (
    (json.channels as Record<string, unknown> | undefined)?.telegram as
      | Record<string, unknown>
      | undefined
  );
  if (!tg) return undefined;

  let token: string | undefined;
  let approvers: unknown;
  const accounts = tg.accounts as Record<string, unknown> | undefined;
  if (accounts && typeof accounts === "object") {
    const def = accounts.default as Record<string, unknown> | undefined;
    if (def) {
      if (typeof def.botToken === "string") token = def.botToken;
      const exec = def.execApprovals as Record<string, unknown> | undefined;
      approvers = exec?.approvers;
    }
  }
  if (!token && typeof tg.botToken === "string") token = tg.botToken;
  if (!approvers) approvers = tg.approvers;

  if (!token) return undefined;

  const allowedUserIds = Array.isArray(approvers)
    ? approvers
        .map((x) => (typeof x === "string" ? Number(x) : (x as number)))
        .filter((n) => Number.isInteger(n))
    : [];

  return { token, allowedUserIds };
}

export default defineCommand({
  meta: {
    name: "telegram",
    description:
      "Configure the Telegram channel (token + allowed users). Validates the token before saving.",
  },
  async run() {
    const code = await runTelegram();
    process.exitCode = code;
  },
});
