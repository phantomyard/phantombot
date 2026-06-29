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
 *     "tofu": true,                     // optional — trust-on-first-use: when the
 *                                       //   allowlist is empty, the FIRST npub to
 *                                       //   DM is trusted, appended here, and the
 *                                       //   bot then locks to it (tofu cleared)
 *     "greeted": ["npub1…", …],         // optional — npubs the bot has already
 *                                       //   sent its proactive "Hello" to. On
 *                                       //   every start the bot greets any
 *                                       //   allowed npub NOT in this list, then
 *                                       //   records it here so restarts don't
 *                                       //   re-spam onboarded contacts.
 *     "group_bots": [                   // optional — the OTHER bots that share
 *       {"name": "kai",  "npub": "…"},  //   groups with this persona. Drives the
 *       {"name": "lena", "npub": "…"}   //   group name-addressing roster (so a
 *     ]                                 //   bot only replies when addressed by
 *                                       //   name / when it holds the thread) AND
 *                                       //   the "never reply to another bot"
 *                                       //   cascade kill. List every sibling.
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
  decodeNpubToHex,
  identityFromNsec,
  type NostrIdentity,
} from "../../lib/nostrIdentity.ts";

/** Filename of the per-persona phantomchat config inside an agent dir. */
export const PHANTOMCHAT_FILE = "phantomchat.json";

/**
 * One SIBLING bot that shares groups with this persona. Both fields matter:
 *   - `name`  feeds the shared name-addressing roster, so every bot in a group
 *             knows when the human has handed the thread to a DIFFERENT bot and
 *             can fall quiet (see decideGroupReply). The roster MUST list every
 *             bot's name verbatim and identically across all of them.
 *   - `npub`  is decoded to `hex` and added to the "don't react to me" set:
 *             a bot NEVER replies to another bot's message (cascade kill —
 *             option (a)). Only the human drives addressing.
 */
export interface PhantomchatGroupBot {
  /** The sibling bot's persona name (its addressing token in groups). */
  name: string;
  /** The sibling bot's npub (or 64-char hex) as written in the file. */
  npub: string;
  /** Decoded lowercase 64-char hex pubkey — the ignore-set comparison form. */
  hex: string;
}

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
  /**
   * Raw npub strings the bot has already sent its proactive onboarding "Hello"
   * to. The startup greet pass greets every entry in `allowedNpubs` that is NOT
   * present here, then appends it — so a restart re-greets only the npubs added
   * since last time, never the ones already onboarded.
   */
  greeted: string[];
  /**
   * Sibling bots that share groups with this persona (name + npub + decoded
   * hex). Drives the group name-addressing roster AND the "ignore other bots"
   * cascade kill. Empty when the file omits `group_bots` — a lone bot in a
   * group still works (it answers when its own name is used).
   */
  groupBots: PhantomchatGroupBot[];
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
  greeted?: unknown;
  group_bots?: unknown;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

/**
 * Parse the raw `group_bots` array into resolved {name, npub, hex} entries.
 * Each entry must have a non-empty string `name` and an `npub` that decodes to
 * a valid pubkey; anything malformed is skipped (a typo in one sibling must not
 * disable the whole gate). Deduped by hex so a doubled entry can't, e.g., make
 * a bot appear twice in the name roster.
 */
function parseGroupBots(v: unknown): PhantomchatGroupBot[] {
  if (!Array.isArray(v)) return [];
  const out: PhantomchatGroupBot[] = [];
  const seenHex = new Set<string>();
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const name = (raw as { name?: unknown }).name;
    const npub = (raw as { npub?: unknown }).npub;
    if (typeof name !== "string" || name.length === 0) continue;
    if (typeof npub !== "string" || npub.length === 0) continue;
    let hex: string;
    try {
      hex = decodeNpubToHex(npub).toLowerCase();
    } catch {
      continue; // not a valid npub/hex — skip this sibling
    }
    if (seenHex.has(hex)) continue;
    seenHex.add(hex);
    out.push({ name, npub, hex });
  }
  return out;
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
    greeted: asStringArray(parsed.greeted),
    groupBots: parseGroupBots(parsed.group_bots),
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
  data: {
    nsec: string;
    relays: string[];
    allowedNpubs: string[];
    tofu?: boolean;
    greeted?: string[];
    groupBots?: PhantomchatGroupBot[];
  },
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
  // Only persist greeted when non-empty — keep fresh files clean.
  if (data.greeted && data.greeted.length > 0) body.greeted = data.greeted;
  // Persist group_bots verbatim ({name, npub}) — the hex is derived on load, so
  // it never goes to disk. Only written when non-empty to keep fresh files clean.
  if (data.groupBots && data.groupBots.length > 0) {
    body.group_bots = data.groupBots.map((b) => ({ name: b.name, npub: b.npub }));
  }
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
    greeted: existing.greeted,
    groupBots: existing.groupBots,
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
    greeted: existing.greeted,
    groupBots: existing.groupBots,
  });
  return allowedNpubs;
}

/**
 * Record that the bot has sent its proactive onboarding "Hello" to `npub`,
 * appending it to the persona's `greeted` list. Idempotent — a npub already
 * present is left as-is. Preserves nsec / relays / allowlist / tofu. Returns
 * the updated greeted list. Best-effort: callers treat a throw as "couldn't
 * persist the greeted marker, carry on" — the worst case is one duplicate
 * greeting on the next restart, never a missed onboarding.
 */
export async function recordGreeted(
  agentDir: string,
  npub: string,
): Promise<string[]> {
  const existing = loadPhantomchatPersonaConfig(agentDir);
  if (!existing) {
    throw new Error(`phantomchat: no config to record greeted npub in ${agentDir}`);
  }
  const greeted = existing.greeted.includes(npub)
    ? existing.greeted
    : [...existing.greeted, npub];
  await savePhantomchatPersonaConfig(agentDir, {
    nsec: existing.identity.nsec,
    relays: existing.relays,
    allowedNpubs: existing.allowedNpubs,
    tofu: existing.tofu,
    greeted,
    groupBots: existing.groupBots,
  });
  return greeted;
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
