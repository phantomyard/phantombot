/**
 * `phantombot env` — manage credentials in the user's ~/.env file.
 *
 * This is the agent's sanctioned write path. Direct `echo … >> ~/.env`
 * by the harnessed agent would lose atomic-rename + 0o600 — the same
 * race PR #31 fixed for phantombot's own .env. Going through this
 * subcommand reuses src/lib/envFile.ts so the agent inherits those
 * guarantees for free.
 *
 * What lives where:
 *   ~/.config/phantombot/.env  — phantombot's own runtime secrets
 *                                 (TTS keys; written by `phantombot voice`).
 *   ~/.env                     — the agent's general-purpose credentials
 *                                 (GITHUB_TOKEN, ssh passphrases, etc.).
 *                                 phantombot sources both via systemd
 *                                 EnvironmentFile= so the running service
 *                                 sees keys from either file.
 *
 * `phantombot env` operates on ~/.env only. The phantombot-owned file
 * stays under voice/install management.
 */

import { defineCommand } from "citty";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  loadEnvFile,
  updateEnvFile,
} from "../lib/envFile.ts";
import type { WriteSink } from "../lib/io.ts";

/**
 * Path to the user's centralized credentials file. Override via env var
 * for testing (no need to touch the real ~/.env).
 */
export function userEnvPath(): string {
  return process.env.PHANTOMBOT_USER_ENV_FILE ?? join(homedir(), ".env");
}

const ENV_VAR_NAME = /^[A-Z_][A-Z0-9_]*$/i;

export interface EnvSetInput {
  name: string;
  value: string;
  envPath?: string;
  out?: WriteSink;
  err?: WriteSink;
}

export async function runEnvSet(input: EnvSetInput): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  if (!ENV_VAR_NAME.test(input.name)) {
    err.write(
      `'${input.name}' is not a valid env var name (alphanumerics + underscore, must start with letter or underscore).\n`,
    );
    return 2;
  }
  await updateEnvFile(input.envPath ?? userEnvPath(), {
    [input.name]: input.value,
  });
  // Acknowledge by name only — never echo the value back. The agent
  // builder section drills this into the persona prompt; this matches.
  out.write(`saved ${input.name} to ${input.envPath ?? userEnvPath()}\n`);
  return 0;
}

export interface EnvGetInput {
  name: string;
  envPath?: string;
  out?: WriteSink;
  err?: WriteSink;
}

export async function runEnvGet(input: EnvGetInput): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const vars = await loadEnvFile(input.envPath ?? userEnvPath());
  const v = vars[input.name];
  if (v === undefined) {
    err.write(`${input.name} not set\n`);
    return 1;
  }
  // Print raw value so callers can `VAR=$(phantombot env get NAME)`.
  // Doc warning: agents should not interactively `env get` because the
  // value lands in conversation history.
  out.write(`${v}\n`);
  return 0;
}

export interface EnvListInput {
  envPath?: string;
  out?: WriteSink;
}

export async function runEnvList(input: EnvListInput = {}): Promise<number> {
  const out = input.out ?? process.stdout;
  const vars = await loadEnvFile(input.envPath ?? userEnvPath());
  const names = Object.keys(vars).sort();
  if (names.length === 0) {
    out.write(`(no entries in ${input.envPath ?? userEnvPath()})\n`);
    return 0;
  }
  // Names only — values would leak via terminal scrollback.
  for (const n of names) out.write(`${n}\n`);
  return 0;
}

export interface EnvUnsetInput {
  name: string;
  envPath?: string;
  out?: WriteSink;
  err?: WriteSink;
}

export async function runEnvUnset(input: EnvUnsetInput): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  if (!ENV_VAR_NAME.test(input.name)) {
    err.write(`'${input.name}' is not a valid env var name.\n`);
    return 2;
  }
  // updateEnvFile treats empty-string value as "delete the key" (existing
  // semantics from PR #29). We rely on that here.
  await updateEnvFile(input.envPath ?? userEnvPath(), { [input.name]: "" });
  out.write(`removed ${input.name} from ${input.envPath ?? userEnvPath()}\n`);
  return 0;
}

export default defineCommand({
  meta: {
    name: "env",
    description:
      "Manage credentials in ~/.env. Atomic write, mode 0o600, idempotent. The harnessed agent should call `phantombot env set NAME value` instead of editing the file directly.",
  },
  subCommands: {
    set: defineCommand({
      meta: { name: "set", description: "Set NAME=value in ~/.env." },
      args: {
        name: { type: "positional", required: true, description: "Env var name (e.g. GITHUB_TOKEN)" },
        value: { type: "positional", required: true, description: "Value to store" },
      },
      async run({ args }) {
        process.exitCode = await runEnvSet({
          name: args.name as string,
          value: args.value as string,
        });
      },
    }),
    get: defineCommand({
      meta: { name: "get", description: "Print the value of NAME from ~/.env." },
      args: {
        name: { type: "positional", required: true, description: "Env var name to read" },
      },
      async run({ args }) {
        process.exitCode = await runEnvGet({ name: args.name as string });
      },
    }),
    list: defineCommand({
      meta: { name: "list", description: "List variable names in ~/.env (values not printed)." },
      async run() {
        process.exitCode = await runEnvList();
      },
    }),
    unset: defineCommand({
      meta: { name: "unset", description: "Remove NAME from ~/.env." },
      args: {
        name: { type: "positional", required: true, description: "Env var name to remove" },
      },
      async run({ args }) {
        process.exitCode = await runEnvUnset({ name: args.name as string });
      },
    }),
  },
});
