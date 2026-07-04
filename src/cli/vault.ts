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
 * The harnessed agent calls `phantombot vault set NAME value` — this is its
 * sanctioned, atomic, encrypted write path.
 */

import { defineCommand } from "citty";

import { loadConfig, personaDir, type Config } from "../config.ts";
import { openPersonaVault, type Vault } from "../lib/vault.ts";
import type { WriteSink } from "../lib/io.ts";

const ENV_VAR_NAME = /^[A-Z_][A-Z0-9_]*$/i;

/**
 * Resolve which persona's vault to operate on. Same precedence the rest of the
 * CLI uses: an explicit --persona wins, then the harness-injected
 * PHANTOMBOT_PERSONA, then the resolved default persona.
 */
export async function resolveVaultPersonaDir(
  explicitPersona?: string,
  config?: Config,
): Promise<string> {
  const cfg = config ?? (await loadConfig());
  const persona =
    explicitPersona || process.env.PHANTOMBOT_PERSONA || cfg.defaultPersona;
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
  value: string;
  persona?: string;
  personaDir?: string;
  vault?: Vault;
  out?: WriteSink;
  err?: WriteSink;
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
  const { vault, owned } = await resolveVault(input);
  try {
    vault.set(input.name, input.value);
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

export default defineCommand({
  meta: {
    name: "vault",
    description:
      "Manage the persona's encrypted secrets vault. AES-256-GCM at rest, key derived from the persona's identity. The harnessed agent should call `phantombot vault set NAME value` instead of editing files directly.",
  },
  subCommands: {
    set: defineCommand({
      meta: { name: "set", description: "Add or update the NAME=value entry in the vault." },
      args: {
        name: { type: "positional", required: true, description: "Secret name (e.g. GITHUB_TOKEN)" },
        value: { type: "positional", required: true, description: "Value to store" },
        persona: { type: "string", description: "Persona whose vault to use. Defaults to PHANTOMBOT_PERSONA / default persona." },
      },
      async run({ args }) {
        process.exitCode = await runVaultSet({
          name: args.name as string,
          value: args.value as string,
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
