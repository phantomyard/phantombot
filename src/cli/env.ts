/**
 * `phantombot env` — DEPRECATED ALIAS for `phantombot vault`.
 *
 * The credential store moved from the plaintext `~/.env` file to a per-persona
 * ENCRYPTED vault (`<personaDir>/vault.sqlite`, AES-256-GCM at rest — see
 * lib/vault.ts and cli/vault.ts). `phantombot env` still works so existing
 * agent muscle-memory and scripts don't break, but it now prints a one-line
 * deprecation notice to stderr and forwards straight to the vault runners.
 *
 * `userEnvPath()` is still exported here because harness.ts writes the Pi
 * routing key to it via updateEnvFile — that write path stays intact so
 * nothing fails to compile or run. (Those writes feed the plaintext-file
 * migration on the next startup, which fans keys into the vault and then
 * removes the file.)
 */

import { defineCommand } from "citty";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  runVaultGet,
  runVaultList,
  runVaultSet,
  runVaultUnset,
} from "./vault.ts";
import type { Vault } from "../lib/vault.ts";
import type { WriteSink } from "../lib/io.ts";

/**
 * Path to the user's legacy centralized credentials file. Override via env var
 * for testing. Still used by harness.ts for the Pi routing key write; the
 * startup migration then folds that file's keys into the vault.
 */
export function userEnvPath(): string {
  return process.env.PHANTOMBOT_USER_ENV_FILE ?? join(homedir(), ".env");
}

/** One-shot deprecation notice to stderr (never to stdout, which carries values). */
function deprecationNotice(err: WriteSink): void {
  err.write(
    "note: `phantombot env` is deprecated — use `phantombot vault`. Forwarding to the encrypted vault.\n",
  );
}

export interface EnvSetInput {
  name: string;
  value: string;
  persona?: string;
  personaDir?: string;
  vault?: Vault;
  out?: WriteSink;
  err?: WriteSink;
}

export async function runEnvSet(input: EnvSetInput): Promise<number> {
  const err = input.err ?? process.stderr;
  deprecationNotice(err);
  return runVaultSet({
    name: input.name,
    value: input.value,
    persona: input.persona,
    personaDir: input.personaDir,
    vault: input.vault,
    out: input.out,
    err: input.err,
  });
}

export interface EnvGetInput {
  name: string;
  persona?: string;
  personaDir?: string;
  vault?: Vault;
  out?: WriteSink;
  err?: WriteSink;
}

export async function runEnvGet(input: EnvGetInput): Promise<number> {
  const err = input.err ?? process.stderr;
  deprecationNotice(err);
  return runVaultGet({
    name: input.name,
    persona: input.persona,
    personaDir: input.personaDir,
    vault: input.vault,
    out: input.out,
    err: input.err,
  });
}

export interface EnvListInput {
  persona?: string;
  personaDir?: string;
  vault?: Vault;
  out?: WriteSink;
  err?: WriteSink;
}

export async function runEnvList(input: EnvListInput = {}): Promise<number> {
  const err = input.err ?? process.stderr;
  deprecationNotice(err);
  return runVaultList({
    persona: input.persona,
    personaDir: input.personaDir,
    vault: input.vault,
    out: input.out,
  });
}

export interface EnvUnsetInput {
  name: string;
  persona?: string;
  personaDir?: string;
  vault?: Vault;
  out?: WriteSink;
  err?: WriteSink;
}

export async function runEnvUnset(input: EnvUnsetInput): Promise<number> {
  const err = input.err ?? process.stderr;
  deprecationNotice(err);
  return runVaultUnset({
    name: input.name,
    persona: input.persona,
    personaDir: input.personaDir,
    vault: input.vault,
    out: input.out,
    err: input.err,
  });
}

export default defineCommand({
  meta: {
    name: "env",
    description:
      "DEPRECATED alias for `phantombot vault`. Forwards to the encrypted secrets vault (values are stored AES-256-GCM at rest, no longer in plaintext ~/.env).",
  },
  subCommands: {
    set: defineCommand({
      meta: { name: "set", description: "Deprecated — see `phantombot vault set`." },
      args: {
        name: { type: "positional", required: true, description: "Secret name (e.g. GITHUB_TOKEN)" },
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
      meta: { name: "get", description: "Deprecated — see `phantombot vault get`." },
      args: {
        name: { type: "positional", required: true, description: "Secret name to read" },
      },
      async run({ args }) {
        process.exitCode = await runEnvGet({ name: args.name as string });
      },
    }),
    list: defineCommand({
      meta: { name: "list", description: "Deprecated — see `phantombot vault list`." },
      async run() {
        process.exitCode = await runEnvList();
      },
    }),
    unset: defineCommand({
      meta: { name: "unset", description: "Deprecated — see `phantombot vault unset`." },
      args: {
        name: { type: "positional", required: true, description: "Secret name to remove" },
      },
      async run({ args }) {
        process.exitCode = await runEnvUnset({ name: args.name as string });
      },
    }),
  },
});
