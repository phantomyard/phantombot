/**
 * `phantombot vault` — manage the persona's ENCRYPTED secrets store.
 *
 * This is the canonical credential store, replacing the old plaintext `~/.env`
 * that `phantombot env` wrote (which now forwards here — see cli/env.ts). Each
 * persona has its own `<personaDir>/vault.sqlite`, encrypted at rest with a key
 * derived from that persona's nsec (see lib/vault.ts). Secrets are decrypted
 * only in-process; the on-disk form is AES-256-GCM ciphertext.
 *
 * The subcommands mirror `phantombot env` 1:1 (set/get/list/unset), including
 * the "saved NAME" ack that never echoes the value and the names-only listing.
 * The harnessed agent pipes a value to `phantombot vault set NAME` so the
 * secret never appears in argv. The positional value remains supported for
 * backward compatibility.
 */

import { defineCommand } from "citty";

import {
  isConfigOwnedEnvMirror,
  isRoutingEnvName,
  loadConfig,
  personaDir,
  resolvePersona,
  type Config,
} from "../config.ts";
import { openPersonaVault, type Vault, vaultTrackedKeys } from "../lib/vault.ts";
import type { WriteSink } from "../lib/io.ts";
import { signalProcessGroup, spawnInNewSession } from "../lib/processGroup.ts";

const ENV_VAR_NAME = /^[A-Z_][A-Z0-9_]*$/i;

/**
 * Resolve which persona's vault to operate on: an explicit --persona wins,
 * then the harness-injected PHANTOMBOT_PERSONA, then the resolved default
 * persona (shared resolvePersona precedence).
 */
export async function resolveVaultPersonaDir(
  explicitPersona?: string,
  config?: Config,
): Promise<string> {
  const cfg = config ?? (await loadConfig());
  const persona = resolvePersona(explicitPersona, cfg);
  return personaDir(cfg, persona);
}

/**
 * Open the vault for a run: either a caller-supplied one (tests) or the active
 * persona's. Returns the vault plus whether we own it (and must close it).
 */
async function resolveVault(input: {
  vault?: Vault;
  personaDir?: string;
  persona?: string;
}): Promise<{ vault: Vault; owned: boolean }> {
  if (input.vault) return { vault: input.vault, owned: false };
  const dir = input.personaDir ?? (await resolveVaultPersonaDir(input.persona));
  return { vault: await openPersonaVault(dir), owned: true };
}

export interface VaultSetInput {
  name: string;
  value?: string;
  allowEmpty?: boolean;
  persona?: string;
  personaDir?: string;
  vault?: Vault;
  out?: WriteSink;
  err?: WriteSink;
  stdin?: VaultInputStream;
}

export type VaultInputStream = AsyncIterable<string | Uint8Array> & {
  isTTY?: boolean;
};

/**
 * Read a secret from stdin without ever reflecting it in output. Refuse a TTY
 * so an accidentally omitted positional value fails instead of hanging until
 * Ctrl-D. Strip exactly one trailing line ending: this makes ordinary shell
 * pipes convenient without changing intentional whitespace inside the value.
 * Refuse an empty result unless the caller explicitly allows it, protecting an
 * existing credential when an upstream pipe fails without producing output.
 */
export async function readVaultValueFromStdin(
  stdin: VaultInputStream = process.stdin,
  allowEmpty = false,
): Promise<string> {
  if (stdin.isTTY) {
    throw new Error(
      "value omitted and stdin is a TTY; pipe the value or pass it as an argument",
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const value = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  if (value === "" && !allowEmpty) {
    throw new Error(
      "stdin was empty; refusing to overwrite with an empty value (use --allow-empty if that is intended, or `vault unset NAME` to remove it)",
    );
  }
  return value;
}

export async function runVaultSet(input: VaultSetInput): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  if (!ENV_VAR_NAME.test(input.name)) {
    err.write(
      `'${input.name}' is not a valid env var name (alphanumerics + underscore, must start with letter or underscore).\n`,
    );
    return 2;
  }
  // Refuse a setting config.toml owns (#452/#465), BEFORE reading stdin.
  //
  // The daemon withholds and may evict these on its next vault read, so
  // accepting one here would print "saved NAME to the vault" and then have the
  // value quietly disappear — the same silent failure that guard exists to
  // kill, at the one moment there is an operator standing here to be told
  // instead. `phantombot env set PHANTOMBOT_PRIMARY_MODEL …` is the spelling
  // every pre-#452 runbook still gives, so this path is reached by habit, not
  // by accident. Rejecting is also why the guard can stay self-extinguishing:
  // nothing puts a mirror back.
  if (isConfigOwnedEnvMirror(input.name)) {
    err.write(
      `${input.name} is a setting, not a secret: it now lives in config.toml ` +
        "and the vault is no longer read for it. Run `phantombot harness` " +
        "(or `/model` in chat) to set it, or edit [harnesses] in " +
        "config.toml directly.\n",
    );
    return 2;
  }
  // Refuse a routing name (#576) for the same reason and at the same moment:
  // the vault is never read for it, so accepting it would print "saved" for a
  // value that can never take effect. Which phantom a process is comes from
  // `--persona`, the environment it was started in, or the configured default.
  if (isRoutingEnvName(input.name)) {
    err.write(
      `${input.name} routes a process to a phantom, so a phantom's vault is ` +
        "never read for it. Pass `--persona <name>`, set it in the " +
        "environment phantombot starts in, or change the default with " +
        "`phantombot persona`.\n",
    );
    return 2;
  }
  let value = input.value;
  if (value === undefined) {
    try {
      value = await readVaultValueFromStdin(input.stdin, input.allowEmpty);
    } catch (e) {
      err.write(`phantombot vault set: ${(e as Error).message}\n`);
      return 2;
    }
  }
  const { vault, owned } = await resolveVault(input);
  try {
    vault.set(input.name, value);
  } finally {
    if (owned) vault.close();
  }
  // Acknowledge by name only — never echo the value back.
  out.write(`saved ${input.name} to the vault\n`);
  return 0;
}

export interface VaultGetInput {
  name: string;
  persona?: string;
  personaDir?: string;
  vault?: Vault;
  out?: WriteSink;
  err?: WriteSink;
}

export async function runVaultGet(input: VaultGetInput): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const { vault, owned } = await resolveVault(input);
  let v: string | undefined;
  try {
    v = vault.get(input.name);
  } finally {
    if (owned) vault.close();
  }
  if (v === undefined) {
    err.write(`${input.name} not set\n`);
    return 1;
  }
  // Print raw value so callers can `VAR=$(phantombot vault get NAME)`.
  out.write(`${v}\n`);
  return 0;
}

export interface VaultListInput {
  persona?: string;
  personaDir?: string;
  vault?: Vault;
  out?: WriteSink;
}

export async function runVaultList(input: VaultListInput = {}): Promise<number> {
  const out = input.out ?? process.stdout;
  const { vault, owned } = await resolveVault(input);
  let names: string[];
  try {
    names = vault.list();
  } finally {
    if (owned) vault.close();
  }
  if (names.length === 0) {
    out.write(`(no entries in the vault)\n`);
    return 0;
  }
  // Names only — values would leak via terminal scrollback.
  for (const n of names) out.write(`${n}\n`);
  return 0;
}

export interface VaultUnsetInput {
  name: string;
  persona?: string;
  personaDir?: string;
  vault?: Vault;
  out?: WriteSink;
  err?: WriteSink;
}

export async function runVaultUnset(input: VaultUnsetInput): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  if (!ENV_VAR_NAME.test(input.name)) {
    err.write(`'${input.name}' is not a valid env var name.\n`);
    return 2;
  }
  const { vault, owned } = await resolveVault(input);
  try {
    vault.unset(input.name);
  } finally {
    if (owned) vault.close();
  }
  out.write(`removed ${input.name} from the vault\n`);
  return 0;
}

export interface VaultExecInput {
  /** Secret names to expose to the command — and nothing else from the vault. */
  secrets: string[];
  /** Shell command, run with `bash -c`. */
  command: string;
  /** Seconds before the command is killed. Default 120, max 600. */
  timeoutS?: number;
  persona?: string;
  personaDir?: string;
  vault?: Vault;
  /** The env the command starts from (default process.env). */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  out?: WriteSink;
  err?: WriteSink;
}

export const VAULT_EXEC_DEFAULT_TIMEOUT_S = 120;
export const VAULT_EXEC_MAX_TIMEOUT_S = 600;

/**
 * Replace every occurrence of each value with «NAME». Longest first. EVERY
 * non-empty value is redacted, however short: a 1-3 character secret is still
 * a secret, and the contract is output without values (PR #821 review).
 */
export function redactSecretValues(text: string, secrets: ReadonlyMap<string, string>): string {
  const pairs = [...secrets.entries()].filter(([, v]) => v.length > 0).sort((a, b) => b[1].length - a[1].length);
  let outText = text;
  for (const [name, value] of pairs) outText = outText.split(value).join(`«${name}»`);
  return outText;
}

/**
 * `phantombot vault exec` / `pbot_vault exec` (#820): run ONE command with
 * only the named secrets added to its environment, and return its output —
 * never the values.
 *
 * The command's env is the caller's env with EVERY name this persona's vault
 * holds removed first (in a daemon-spawned turn they were injected
 * wholesale), then only the requested ones put back. So a stray `env` inside
 * the command shows the secrets it asked for, not the whole vault. Any
 * requested value that still turns up in the output (an echo, a verbose
 * client) is redacted to «NAME» before it reaches the caller — the
 * transcript-hygiene half of the contract. Same model as command tasks'
 * `--secret NAME`. Exit code = the command's.
 */
export async function runVaultExec(input: VaultExecInput): Promise<number> {
  const out = input.out ?? process.stdout;
  const err = input.err ?? process.stderr;
  const names = [...new Set(input.secrets.map((s) => s.trim()).filter(Boolean))];
  for (const n of names) {
    if (!ENV_VAR_NAME.test(n)) {
      err.write(`'${n}' is not a valid env var name.\n`);
      return 2;
    }
  }
  if (!input.command.trim()) {
    err.write("vault exec: empty command\n");
    return 2;
  }
  const timeoutS = Math.min(
    VAULT_EXEC_MAX_TIMEOUT_S,
    Math.max(1, Math.trunc(input.timeoutS ?? VAULT_EXEC_DEFAULT_TIMEOUT_S)),
  );
  const { vault, owned } = await resolveVault(input);
  const values = new Map<string, string>();
  let allNames: string[];
  try {
    allNames = vault.list();
    for (const n of names) {
      const v = vault.get(n);
      if (v === undefined) {
        err.write(`${n} not set\n`);
        return 1;
      }
      values.set(n, v);
    }
  } finally {
    if (owned) vault.close();
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.env ?? process.env)) {
    if (v !== undefined) env[k] = v;
  }
  for (const k of allNames) delete env[k];
  for (const k of vaultTrackedKeys()) delete env[k];
  for (const [k, v] of values) env[k] = v;

  // Own session/process group (Job Object on Windows), so the timeout kills
  // the WHOLE tree: proc.kill would signal only the outer bash, and a
  // descendant would outlive the cap, holding the output pipes open and
  // still performing side effects.
  const proc = spawnInNewSession(["bash", "-c", input.command], {
    cwd: input.cwd ?? process.cwd(),
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (typeof proc.pid === "number") signalProcessGroup(proc.pid, "SIGKILL");
    try {
      proc.kill("SIGKILL"); // the leader, should the group signal have failed
    } catch {
      /* already gone */
    }
  }, timeoutS * 1000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  if (stdout) out.write(redactSecretValues(stdout, values));
  if (stderr) err.write(redactSecretValues(stderr, values));
  if (timedOut) {
    err.write(`vault exec: killed after ${timeoutS}s\n`);
    return 124;
  }
  return code;
}

export default defineCommand({
  meta: {
    name: "vault",
    description:
      "Manage the encrypted secrets vault. Pipe values in to keep them out of argv.",
  },
  subCommands: {
    set: defineCommand({
      meta: { name: "set", description: "Add or update the NAME=value entry in the vault." },
      args: {
        name: { type: "positional", required: true, description: "Secret name (e.g. GITHUB_TOKEN)" },
        value: {
          type: "positional",
          required: false,
          description: "Value to store; omit to read from stdin",
        },
        allowEmpty: {
          type: "boolean",
          description: "Allow omitted-value stdin to store an empty value",
        },
        persona: { type: "string", description: "Persona whose vault to use. Defaults to PHANTOMBOT_PERSONA / default persona." },
      },
      async run({ args }) {
        process.exitCode = await runVaultSet({
          name: args.name as string,
          value: typeof args.value === "string" ? args.value : undefined,
          allowEmpty: args.allowEmpty === true,
          persona: args.persona ? String(args.persona) : undefined,
        });
      },
    }),
    get: defineCommand({
      meta: { name: "get", description: "Print the value of NAME from the vault." },
      args: {
        name: { type: "positional", required: true, description: "Secret name to read" },
        persona: { type: "string", description: "Persona whose vault to use." },
      },
      async run({ args }) {
        process.exitCode = await runVaultGet({
          name: args.name as string,
          persona: args.persona ? String(args.persona) : undefined,
        });
      },
    }),
    list: defineCommand({
      meta: { name: "list", description: "List secret names in the vault (values not printed)." },
      args: {
        persona: { type: "string", description: "Persona whose vault to use." },
      },
      async run({ args }) {
        process.exitCode = await runVaultList({
          persona: args.persona ? String(args.persona) : undefined,
        });
      },
    }),
    exec: defineCommand({
      meta: {
        name: "exec",
        description:
          "Run COMMAND with only the named secrets in its env; prints its output, never the values.",
      },
      args: {
        command: { type: "positional", required: true, description: "Shell command (quoted), run with bash -c" },
        secrets: { type: "string", description: "Comma-separated secret names to expose, e.g. GITHUB_CLASSIC_TOKEN" },
        timeout: { type: "string", description: `Seconds before the command is killed (default ${VAULT_EXEC_DEFAULT_TIMEOUT_S}, max ${VAULT_EXEC_MAX_TIMEOUT_S})` },
        persona: { type: "string", description: "Persona whose vault to use." },
      },
      async run({ args }) {
        process.exitCode = await runVaultExec({
          command: String(args.command),
          secrets: args.secrets ? String(args.secrets).split(",") : [],
          timeoutS: args.timeout !== undefined ? Number(args.timeout) : undefined,
          persona: args.persona ? String(args.persona) : undefined,
        });
      },
    }),
    unset: defineCommand({
      meta: { name: "unset", description: "Remove NAME from the vault." },
      args: {
        name: { type: "positional", required: true, description: "Secret name to remove" },
        persona: { type: "string", description: "Persona whose vault to use." },
      },
      async run({ args }) {
        process.exitCode = await runVaultUnset({
          name: args.name as string,
          persona: args.persona ? String(args.persona) : undefined,
        });
      },
    }),
  },
});
