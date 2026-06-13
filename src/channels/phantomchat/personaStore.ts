/**
 * Per-persona phantomchat identity + config store.
 *
 * The whole point: a persona's phantomchat identity (its Nostr keypair) and
 * channel settings (relays, allowlist) live INSIDE the persona's own agent
 * directory — next to SOUL.md — in a single `phantomchat.json` file. That
 * makes a persona folder fully self-contained and PORTABLE: copy/paste it to
 * another PC or VM and its npub, relays, and allowlist travel with it. A single
 * user account can hold many persona folders, each with its own npub — exactly
 * mirroring how Telegram runs one bot (token) per persona.
 *
 * This replaces the earlier instance-global model where the nsec lived in
 * ~/.env (PHANTOMCHAT_NSEC) and relays/allowlist lived in config.toml — that
 * was glued to the box and couldn't express more than one identity.
 *
 * File: `<agentDir>/phantomchat.json` (mode 0600), shape:
 *   {
 *     "nsec": "nsec1…",                 // REQUIRED — presence enables the channel
 *     "relays": ["wss://…", …],         // optional CACHE — refreshed from the
 *                                       //   canonical /relays.json on startup;
 *                                       //   falls back to the PWA seed set
 *     "allowed_npubs": ["npub1…", …],   // optional — the trust allowlist
 *     "tofu": true                      // optional — trust-on-first-use: when the
 *                                       //   allowlist is empty, the FIRST npub to
 *                                       //   DM is trusted, appended here, and the
 *                                       //   bot then locks to it (tofu cleared)
 *   }
 *
 * Allowlist semantics:
 *   - allowed_npubs non-empty → only those npubs are answered. The FIRST entry
 *     is the incident-notification target.
 *   - allowed_npubs empty + tofu true → TOFU: first DMer is trusted + locked.
 *   - allowed_npubs empty + tofu false/absent → open bot (answer anyone), warned.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  DEFAULT_PHANTOMCHAT_RELAYS,
  personaDir,
  type Config,
} from "../../config.ts";
import { log } from "../../lib/logger.ts";
import {
  decodeAllowedNpubs,
  identityFromNsec,
  type NostrIdentity,
} from "../../lib/nostrIdentity.ts";

/** Filename of the per-persona phantomchat config inside an agent dir. */
export const PHANTOMCHAT_FILE = "phantomchat.json";

/** Resolved phantomchat config for one persona. */
export interface PhantomchatPersonaConfig {
  /** The persona's Nostr identity (secret key + npub/nsec/hex encodings). */
  identity: NostrIdentity;
  /** Relays this persona connects to (defaults applied when the file omits them). */
  relays: string[];
  /** Raw npub strings from the file (human-readable form). */
  allowedNpubs: string[];
  /** Decoded lowercase 64-char hex pubkeys — the auth-gate comparison form. */
  allowedHex: string[];
  /**
   * Trust-on-first-use. When true AND the allowlist is empty, the first npub to
   * DM is trusted, appended to allowed_npubs, and the bot locks to it. Ignored
   * once allowed_npubs is non-empty.
   */
  tofu: boolean;
  /** Absolute path to the phantomchat.json this came from. */
  path: string;
}

/** Path to a persona's phantomchat.json given its agent directory. */
export function phantomchatConfigPath(agentDir: string): string {
  return join(agentDir, PHANTOMCHAT_FILE);
}

/** On-disk JSON shape. Kept snake_case to match the rest of phantombot config. */
interface PhantomchatFileShape {
  nsec?: string;
  relays?: unknown;
  allowed_npubs?: unknown;
  tofu?: unknown;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

/**
 * Load a persona's phantomchat config from `<agentDir>/phantomchat.json`.
 * Returns undefined when the file is absent, unparseable, or has no usable
 * nsec — the caller treats that as "phantomchat not configured for this
 * persona" and simply doesn't start a listener for it.
 */
export function loadPhantomchatPersonaConfig(
  agentDir: string,
): PhantomchatPersonaConfig | undefined {
  const path = phantomchatConfigPath(agentDir);
  if (!existsSync(path)) return undefined;
  let parsed: PhantomchatFileShape;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as PhantomchatFileShape;
  } catch (e) {
    log.warn(`phantomchat: failed to parse ${path} — skipping`, {
      error: (e as Error).message,
    });
    return undefined;
  }
  if (!parsed || typeof parsed.nsec !== "string" || parsed.nsec.trim() === "") {
    return undefined;
  }
  let identity: NostrIdentity;
  try {
    identity = identityFromNsec(parsed.nsec);
  } catch (e) {
    log.warn(`phantomchat: invalid nsec in ${path} — skipping`, {
      error: (e as Error).message,
    });
    return undefined;
  }
  const relaysFromFile = asStringArray(parsed.relays);
  const relays =
    relaysFromFile.length > 0 ? relaysFromFile : [...DEFAULT_PHANTOMCHAT_RELAYS];
  const allowedNpubs = asStringArray(parsed.allowed_npubs);
  return {
    identity,
    relays,
    allowedNpubs,
    allowedHex: decodeAllowedNpubs(allowedNpubs),
    tofu: parsed.tofu === true,
    path,
  };
}

/**
 * Atomically write a persona's phantomchat.json at mode 0600 (the nsec is a
 * secret). Creates the agent dir if needed. Tempfile + rename avoids the
 * world-readable window a write-then-chmod would leave.
 */
export async function savePhantomchatPersonaConfig(
  agentDir: string,
  data: { nsec: string; relays: string[]; allowedNpubs: string[]; tofu?: boolean },
): Promise<string> {
  const path = phantomchatConfigPath(agentDir);
  await mkdir(dirname(path), { recursive: true });
  const body: PhantomchatFileShape = {
    nsec: data.nsec,
    relays: data.relays,
    allowed_npubs: data.allowedNpubs,
  };
  // Only persist tofu when explicitly enabled — keep the file clean otherwise.
  if (data.tofu) body.tofu = true;
  const tmp = `${path}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(body, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tmp, path);
  } catch (e) {
    try {
      await unlink(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw e;
  }
  return path;
}

/**
 * Update ONLY the cached relay list in a persona's phantomchat.json, preserving
 * nsec / allowlist / tofu. Used by startup to write back the canonical relays
 * fetched from /relays.json. No-op (returns false) when the persona has no
 * usable config. Best-effort: callers treat a throw as "couldn't cache, carry
 * on with the in-memory relays".
 */
export async function cacheRelaysForPersona(
  agentDir: string,
  relays: string[],
): Promise<boolean> {
  const existing = loadPhantomchatPersonaConfig(agentDir);
  if (!existing) return false;
  await savePhantomchatPersonaConfig(agentDir, {
    nsec: existing.identity.nsec,
    relays,
    allowedNpubs: existing.allowedNpubs,
    tofu: existing.tofu,
  });
  return true;
}

/**
 * TOFU commit: append `npub` to the allowlist and CLEAR tofu (the bot is now
 * locked to its trusted set). Idempotent — a npub already present is left as-is
 * and tofu is still cleared. Preserves nsec + relays. Returns the updated list.
 */
export async function recordTrustedNpub(
  agentDir: string,
  npub: string,
): Promise<string[]> {
  const existing = loadPhantomchatPersonaConfig(agentDir);
  if (!existing) {
    throw new Error(`phantomchat: no config to record trusted npub in ${agentDir}`);
  }
  const allowedNpubs = existing.allowedNpubs.includes(npub)
    ? existing.allowedNpubs
    : [...existing.allowedNpubs, npub];
  await savePhantomchatPersonaConfig(agentDir, {
    nsec: existing.identity.nsec,
    relays: existing.relays,
    allowedNpubs,
    tofu: false,
  });
  return allowedNpubs;
}

/** One persona with a configured phantomchat identity. */
export interface PhantomchatPersonaSpec {
  persona: string;
  agentDir: string;
  config: PhantomchatPersonaConfig;
}

/**
 * Scan every persona directory under `config.personasDir` and return the ones
 * that have a usable phantomchat.json. This is what makes the channel
 * multi-persona: each persona folder with an identity becomes its own listener
 * (own npub), with NO config.toml editing required — drop a portable persona
 * folder in and it just works.
 */
export function listPhantomchatPersonas(
  config: Config,
): PhantomchatPersonaSpec[] {
  const out: PhantomchatPersonaSpec[] = [];
  let names: string[];
  if (!existsSync(config.personasDir)) return out;
  try {
    names = readdirSync(config.personasDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return out;
  }
  for (const persona of names) {
    const agentDir = personaDir(config, persona);
    const pcConfig = loadPhantomchatPersonaConfig(agentDir);
    if (pcConfig) out.push({ persona, agentDir, config: pcConfig });
  }
  return out;
}
