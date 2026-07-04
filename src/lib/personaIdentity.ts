/**
 * Shared per-persona Nostr identity — the single source of the persona's
 * long-lived secret key (`nsec`), used by BOTH the phantomchat channel and
 * the encrypted secrets vault (lib/vault.ts).
 *
 * Storage: `<personaDir>/identity.json` (mode 0600), shape:
 *   { "nsec": "nsec1…" }
 *
 * Historically the nsec lived only inside `<personaDir>/phantomchat.json`
 * (see channels/phantomchat/personaStore.ts) — coupling the persona's crypto
 * identity to one channel. The vault needs the same key to derive its AES
 * encryption key, so the identity is hoisted here into its own file. Both
 * consumers now read from `identity.json`.
 *
 * `getOrCreatePersonaIdentity` is idempotent and does an at-most-once,
 * best-effort MIGRATION: if `identity.json` is absent but a legacy
 * `phantomchat.json` in the same dir already holds an nsec, that nsec is
 * MOVED into `identity.json` (the channel file keeps its copy — it is left
 * untouched so the channel keeps working; only the identity is now sourced
 * from the shared file). Otherwise a fresh key is generated in-process.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { generateSecretKey } from "nostr-tools/pure";

import {
  identityFromNsec,
  nsecEncode,
  type NostrIdentity,
} from "./nostrIdentity.ts";

/** Filename of the shared per-persona identity file inside a persona dir. */
export const IDENTITY_FILE = "identity.json";

/** Legacy channel file that used to be the sole nsec home. */
const LEGACY_PHANTOMCHAT_FILE = "phantomchat.json";

/** Path to a persona's identity.json given its dir. */
export function personaIdentityPath(personaDir: string): string {
  return join(personaDir, IDENTITY_FILE);
}

/** On-disk shape of identity.json. */
interface IdentityFileShape {
  nsec?: string;
}

/** Read an nsec string out of a JSON file, or undefined if absent/unusable. */
function readNsecFromJson(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as IdentityFileShape;
    if (parsed && typeof parsed.nsec === "string" && parsed.nsec.trim() !== "") {
      return parsed.nsec.trim();
    }
  } catch {
    // Unparseable file — treat as absent so a fresh identity is created.
  }
  return undefined;
}

/**
 * Atomically write `<personaDir>/identity.json` at mode 0600 (the nsec is a
 * secret). Tempfile + rename avoids the world-readable window a
 * write-then-chmod would leave — same guarantee as savePhantomchatPersonaConfig.
 * Public so setup flows (e.g. `phantombot phantomchat`) that mint an identity
 * with their own generator can persist it to the shared file.
 */
export async function writePersonaIdentity(
  personaDir: string,
  nsec: string,
): Promise<void> {
  return writeIdentityFile(personaDir, nsec);
}

async function writeIdentityFile(personaDir: string, nsec: string): Promise<void> {
  const path = personaIdentityPath(personaDir);
  await mkdir(dirname(path), { recursive: true });
  const body: IdentityFileShape = { nsec };
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
}

/**
 * Synchronously read the persona's nsec from `identity.json`, or undefined if
 * absent/unusable. Read-only companion to getOrCreatePersonaIdentity for
 * callers that must stay synchronous (e.g. loadPhantomchatPersonaConfig) and
 * only want to PREFER the shared identity, falling back to their own file.
 * Never creates or migrates anything.
 */
export function readPersonaIdentityNsec(personaDir: string): string | undefined {
  return readNsecFromJson(personaIdentityPath(personaDir));
}

/**
 * Resolve the persona's Nostr identity, creating it on first use. Idempotent.
 *
 * Resolution order:
 *   1. `<personaDir>/identity.json` — the canonical shared file.
 *   2. Legacy `<personaDir>/phantomchat.json` nsec — MOVED into identity.json.
 *   3. A freshly generated random secret key, written to identity.json.
 *
 * Returns the full NostrIdentity (secret bytes + npub/nsec/hex encodings).
 */
export async function getOrCreatePersonaIdentity(
  personaDir: string,
): Promise<NostrIdentity> {
  // 1. Canonical file already present.
  const existing = readNsecFromJson(personaIdentityPath(personaDir));
  if (existing) {
    return identityFromNsec(existing);
  }

  // 2. Legacy migration: hoist the nsec out of phantomchat.json if present.
  const legacy = readNsecFromJson(join(personaDir, LEGACY_PHANTOMCHAT_FILE));
  if (legacy) {
    await writeIdentityFile(personaDir, legacy);
    return identityFromNsec(legacy);
  }

  // 3. Generate a fresh identity in-process and persist it.
  const secretKey = generateSecretKey();
  const nsec = nsecEncode(secretKey);
  await writeIdentityFile(personaDir, nsec);
  return identityFromNsec(nsec);
}
