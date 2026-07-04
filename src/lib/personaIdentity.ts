/**
 * Shared per-persona Nostr identity — the single source of the persona's
 * long-lived secret key (`nsec`), used by BOTH the phantomchat channel and
 * the encrypted secrets vault (lib/vault.ts).
 *
 * Storage: `<personaDir>/identity.json`, shape:
 *   { "nsec": "nsec1…" }
 * Locked to the owner alone: mode 0600 on POSIX, an explicit owner-only ACL on
 * Windows (where mode bits are ignored) — see lib/filePermissions.ts.
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
import { link, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { generateSecretKey } from "nostr-tools/pure";

import { restrictFileToCurrentUser } from "./filePermissions.ts";
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

/** A collision-resistant tempfile path alongside `path`. */
function uniqueTmpPath(path: string): string {
  return `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
}

/**
 * Create identity.json holding `nsec` ONLY IF it doesn't already exist, returning
 * the nsec that is DURABLY PERSISTED on disk (ours if we won, the incumbent's if
 * we lost). Atomic create-if-absent: safe to call concurrently, and safe to call
 * when the file may already exist — an existing identity.json is NEVER overwritten.
 * This is the single race-safe primitive for minting the shared identity; callers
 * must not do check-then-write (existsSync + unconditional rename) themselves.
 *
 * Mechanism: write a per-process-unique tempfile (mode 0600), lock it to the
 * current user (owner-only ACL on Windows; the mode already suffices on POSIX),
 * then hard-LINK it into place. `link()` is atomic and fails with EEXIST if the
 * target already exists, so exactly one racer wins; every loser reads the
 * winner's nsec back and adopts it. This closes the check-then-act race where
 * two processes that both saw "no identity.json" mint divergent nsecs —
 * whichever wrote last would
 * orphan everything the other had already encrypted under its key.
 *
 * Fails CLOSED: if identity.json already exists but its nsec can't be read back
 * (malformed / truncated file), this THROWS rather than returning the caller's
 * in-process `nsec` — because that value never reached disk, and handing it back
 * would let the vault encrypt rows under a key the next process can't reproduce
 * (silent, permanent data loss). A thrown error surfaces the corrupt file instead.
 */
export async function createPersonaIdentityIfAbsent(
  personaDir: string,
  nsec: string,
): Promise<string> {
  const path = personaIdentityPath(personaDir);
  await mkdir(dirname(path), { recursive: true });
  const body: IdentityFileShape = { nsec };
  const tmp = uniqueTmpPath(path);
  try {
    await writeFile(tmp, JSON.stringify(body, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    // Lock the file down to the current user BEFORE linking it into place, so
    // the canonical identity.json is restrictive from birth (never briefly
    // readable by other principals). On POSIX the mode 0o600 above already does
    // this and this is a no-op; on Windows the mode bits are ignored, so we
    // apply an explicit owner-only ACL to the tmp file — the hard link below
    // shares the same security descriptor, so identity.json inherits it. Fails
    // CLOSED: a lockdown error throws here, before link(), so no world-readable
    // identity.json is ever created (the finally block cleans up the tmp).
    restrictFileToCurrentUser(tmp);
    try {
      await link(tmp, path);
      return nsec; // we won the race
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        // Lost the race — adopt the winner's durably-stored identity.
        const winner = readNsecFromJson(path);
        if (winner) return winner;
        // Present-but-unreadable identity.json: fail closed rather than hand back
        // an nsec that isn't on disk (see the doc comment above).
        throw new Error(
          `identity.json exists at ${path} but its nsec is unreadable; refusing ` +
            `to return a transient identity that would orphan encrypted vault data`,
        );
      }
      throw e;
    }
  } finally {
    try {
      await unlink(tmp);
    } catch {
      /* best-effort cleanup of the tmp hard-link source */
    }
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
  //    Exclusive-create so a concurrent racer can't end up migrating to a
  //    different value (both would read the same legacy nsec here anyway, but
  //    the race-safe path keeps the invariant "first write wins, losers adopt").
  const legacy = readNsecFromJson(join(personaDir, LEGACY_PHANTOMCHAT_FILE));
  if (legacy) {
    const persisted = await createPersonaIdentityIfAbsent(personaDir, legacy);
    return identityFromNsec(persisted);
  }

  // 3. Generate a fresh identity in-process and persist it race-safely: if
  //    another process generated one between our read above and this write, we
  //    adopt theirs rather than clobbering (which would orphan their vault).
  const secretKey = generateSecretKey();
  const nsec = nsecEncode(secretKey);
  const persisted = await createPersonaIdentityIfAbsent(personaDir, nsec);
  return identityFromNsec(persisted);
}
