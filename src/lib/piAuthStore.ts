/**
 * Writer for Pi's own auth store: ~/.pi/agent/auth.json.
 *
 * WHY THIS EXISTS (issue #312): `pi --list-models` reads auth ONLY from this
 * file and the providers' native env vars — it ignores `--api-key`. The
 * onboarding wizard collects the provider key into phantombot's own env store
 * (PHANTOMBOT_PI_API_KEY, threaded per-turn) and used to refresh the model
 * catalog by injecting the native env var into the `--list-models` child.
 * That works on Linux but proved unreliable elsewhere (macOS repro in #312),
 * leaving fresh installs with an empty catalog and free-text model entry.
 * Keying Pi directly fixes it because the first catalog fetch then succeeds —
 * so the wizard now merge-writes the key into Pi's store too.
 *
 * SCOPE: this module ADDS/REPLACES the api_key entry for the provider the
 * operator just keyed, with two deliberate exceptions:
 *   - `restorePiAuth`, which puts back a snapshot the wizard took moments
 *     earlier (including removing a file that did not exist before the wizard
 *     created it) when the operator declines to apply the configuration. It is
 *     a rollback of our own write, never a deletion of pre-existing user state.
 *   - `removePiApiKey`, which deletes a provider's api_key entry — but ONLY
 *     from an explicitly-named agentDir (type-enforced: the host's `~/.pi` is
 *     never deletable). The native (embedded) engine's agent dir is
 *     PER-PERSONA (lib/nativeAgentDir.ts), so a wizard-written api_key entry
 *     there would outvote the per-turn env relay and decide THIS persona's key
 *     even after a vault rotation (PR #606 review). Each relayed turn
 *     therefore strips the provider's entry from that persona's OWN store
 *     before spawn (harnesses/pi.ts): while a key is being relayed, env is the
 *     only resolution source. Persona-scoping is what makes the strip safe on
 *     a multi-persona host — a sibling's tier-2 fallback or oauth login lives
 *     in the sibling's own store and is unreachable here. That strip is
 *     FAIL-CLOSED: if it cannot complete — or an oauth entry survives it — the
 *     relayed turn ABORTS before spawn rather than risk resolving the wrong
 *     credential. Outside the native agent dir this module never deletes.
 *
 * Otherwise, in the HOST store (~/.pi) this module is WRITE-ONLY: phantombot
 * never deletes from Pi's own store. The "Use Pi's own config" path
 * (clearPiRouting) delegates to the very login this file holds, so erasing it
 * would break the mode it enables. Pi's host store is shared user state
 * (interactive `pi` logins included) — we add/replace an api_key entry for the
 * provider the operator just keyed, and nothing else.
 *
 * GUARDS (Pi's auth.json is user-owned, so we are conservative):
 *   - existing oauth entry for the same provider → left untouched (an
 *     interactive `/login` beats a wizard key; the provider is already keyed)
 *   - existing file is unparseable or not a JSON object → REFUSE to write
 *     rather than clobber unknown state
 *   - all other providers' entries are preserved verbatim
 */

import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * In-process serialization of writers, keyed by target path. Pi's auth.json
 * is updated read→merge→rename, which is only safe if no two writers overlap:
 * without this, two concurrent calls can both read the same old store and the
 * later rename silently drops the other's provider entry. The chain makes
 * each call's read+merge+rename atomic relative to other phantombot writers
 * in this process. (Cross-process overlap — e.g. an interactive `pi /login`
 * racing the wizard — is out of scope for a lock-free file; the oauth guard
 * and refuse-to-clobber rules keep that case safe-by-refusal.)
 */
const writeChains = new Map<string, Promise<void>>();

async function serialized<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(path) ?? Promise.resolve();
  let result!: T;
  const next = prev.then(async () => {
    result = await fn();
  });
  writeChains.set(path, next);
  try {
    await next;
  } finally {
    if (writeChains.get(path) === next) writeChains.delete(path);
  }
  return result;
}

export function piAuthJsonPath(home: string = homedir()): string {
  return join(home, ".pi", "agent", "auth.json");
}

/**
 * Where a write/read should land. Default: the host pi's own auth.json.
 * NATIVE callers pass the isolated agent dir (lib/nativeAgentDir.ts) — the
 * embedded engine must never read or write the user's `~/.pi`.
 */
export type PiAuthTarget = { home?: string; agentDir?: string };

function authPathFor(target?: PiAuthTarget): string {
  if (target?.agentDir) return join(target.agentDir, "auth.json");
  return piAuthJsonPath(target?.home);
}

/** Back-compat: older callers passed a plain home dir string. */
function normalizeAuthTarget(target?: PiAuthTarget | string): PiAuthTarget | undefined {
  return typeof target === "string" ? { home: target } : target;
}

/** One entry in Pi's auth.json. OAuth entries carry more fields; we only read `type`. */
interface PiAuthEntry {
  type?: string;
  key?: string;
  [k: string]: unknown;
}

export type PiAuthMerge =
  | { action: "write"; store: Record<string, PiAuthEntry> }
  | { action: "skip-oauth" }
  | { action: "refuse"; reason: string };

/**
 * Pure merge decision: given the raw existing file content (`undefined` when
 * the file does not exist yet — fresh install ⇒ start from an empty object),
 * decide what writing `provider`'s api_key should do. Exported for tests.
 */
export function mergePiApiKey(
  existingText: string | undefined,
  provider: string,
  apiKey: string,
): PiAuthMerge {
  let store: Record<string, PiAuthEntry> = {};
  if (existingText !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existingText);
    } catch {
      return {
        action: "refuse",
        reason: "existing auth.json is not valid JSON — refusing to clobber it",
      };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        action: "refuse",
        reason: "existing auth.json is not a JSON object — refusing to clobber it",
      };
    }
    store = parsed as Record<string, PiAuthEntry>;
    const current = store[provider];
    if (current && typeof current === "object" && current.type === "oauth") {
      return { action: "skip-oauth" };
    }
  }
  store[provider] = { type: "api_key", key: apiKey };
  return { action: "write", store };
}

/**
 * The raw bytes of Pi's auth.json, or `undefined` when the file does not
 * exist. Paired with `restorePiAuth` so the brain wizard can roll the key
 * write back when the operator declines to apply the configuration it was
 * collected for — see `snapshotPiRouting` for why the wizard writes first
 * and asks later.
 */
export async function snapshotPiAuth(
  target?: PiAuthTarget | string,
): Promise<string | undefined> {
  const path = authPathFor(normalizeAuthTarget(target));
  return serialized(path, async () => {
    try {
      return await readFile(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  });
}

/**
 * Put a `snapshotPiAuth` result back, atomically. `undefined` means the file
 * did not exist when the snapshot was taken, so it is removed again rather
 * than left holding a key the operator discarded. Never throws: a failed
 * rollback is reported, because the caller is already on an error path.
 */
export async function restorePiAuth(
  snapshot: string | undefined,
  target?: PiAuthTarget | string,
): Promise<{ ok: boolean; path: string; reason?: string }> {
  const path = authPathFor(normalizeAuthTarget(target));
  return serialized(path, async () => {
    try {
      if (snapshot === undefined) {
        try {
          await unlink(path);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        return { ok: true, path };
      }
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      const fh = await open(tmp, "wx", 0o600);
      try {
        await fh.writeFile(snapshot, "utf8");
      } finally {
        await fh.close();
      }
      await rename(tmp, path);
      return { ok: true, path };
    } catch (e) {
      return {
        ok: false,
        path,
        reason: e instanceof Error ? e.message : String(e),
      };
    }
  });
}

export type PiAuthWriteResult =
  | { ok: true; path: string; skipped?: "oauth-present" }
  | { ok: false; path: string; reason: string };

export type PiAuthRemoveResult =
  | { ok: true; path: string; removed: boolean; skipped?: "oauth-present" }
  | { ok: false; path: string; reason: string };

/**
 * Delete a provider's api_key entry from Pi's auth.json — the NATIVE store
 * strip for relayed turns (PR #606 review). HARD-SCOPED: without an explicit
 * `agentDir` target this refuses outright — the host's `~/.pi` is shared user
 * state (interactive logins, other tooling) and is never deletable by
 * phantombot; only the phantombot-owned native agent dir may be touched.
 *
 * Guards mirror `writePiApiKey`: an oauth entry for the provider is SKIPPED
 * (never deleted), an unparseable file is refused byte-for-byte, every other
 * provider's entry is preserved verbatim, and the rewrite is atomic at 0600.
 * Serialized with the other writers via the same per-path chain. Never
 * throws: failures come back in the result — the harness turns a failed
 * strip (or a skipped oauth entry, which would outrank the relayed env key)
 * into a fail-closed abort of the relayed turn.
 */
export async function removePiApiKey(
  provider: string,
  target?: PiAuthTarget,
): Promise<PiAuthRemoveResult> {
  const path = authPathFor(target);
  if (!target?.agentDir) {
    return {
      ok: false,
      path,
      reason:
        "removePiApiKey requires an explicit agentDir target — the host ~/.pi is shared user state and is never deletable by phantombot",
    };
  }
  return serialized(path, () => removePiApiKeyInner(provider, path));
}

async function removePiApiKeyInner(
  provider: string,
  path: string,
): Promise<PiAuthRemoveResult> {
  let existing: string;
  try {
    existing = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, path, removed: false };
    }
    return { ok: false, path, reason: e instanceof Error ? e.message : String(e) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    return {
      ok: false,
      path,
      reason: "existing auth.json is not valid JSON — refusing to rewrite it",
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      path,
      reason: "existing auth.json is not a JSON object — refusing to rewrite it",
    };
  }
  const store = parsed as Record<string, PiAuthEntry>;
  const current = store[provider];
  if (!current) return { ok: true, path, removed: false };
  if (typeof current === "object" && current.type === "oauth") {
    return { ok: true, path, removed: false, skipped: "oauth-present" };
  }
  delete store[provider];
  try {
    // Same discipline as writePiApiKeyInner: unique exclusively-created
    // tempfile at 0600, atomic rename, best-effort cleanup on failure.
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      const fh = await open(tmp, "wx", 0o600);
      try {
        await fh.writeFile(JSON.stringify(store, null, 2) + "\n", "utf8");
      } finally {
        await fh.close();
      }
      await rename(tmp, path);
    } catch (e) {
      try {
        await unlink(tmp);
      } catch {
        /* best-effort cleanup */
      }
      throw e;
    }
    return { ok: true, path, removed: true };
  } catch (e) {
    return {
      ok: false,
      path,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Merge-write an api_key for `provider` into Pi's auth.json, preserving every
 * other entry. Atomic (tmp + rename), mode 0o600 — same discipline as
 * envFile.ts. Never throws: failures are reported in the result so the wizard
 * can fall back to the env-injected catalog refresh.
 *
 * `home` is injectable for tests.
 */
export async function writePiApiKey(
  provider: string,
  apiKey: string,
  target?: PiAuthTarget,
): Promise<PiAuthWriteResult> {
  const path = authPathFor(target);
  return serialized(path, () => writePiApiKeyInner(provider, apiKey, path));
}

async function writePiApiKeyInner(
  provider: string,
  apiKey: string,
  path: string,
): Promise<PiAuthWriteResult> {
  try {
    const existing = existsSync(path)
      ? await readFile(path, "utf8")
      : undefined;
    const merge = mergePiApiKey(existing, provider, apiKey);
    if (merge.action === "refuse") {
      return { ok: false, path, reason: merge.reason };
    }
    if (merge.action === "skip-oauth") {
      return { ok: true, path, skipped: "oauth-present" };
    }
    await mkdir(dirname(path), { recursive: true });
    // Write to a unique, exclusively-created tempfile at mode 0o600 then
    // atomically rename over the target, so a fresh file is never briefly
    // world-readable (mirrors saveEnvFile). The tempfile is unique per call
    // and opened O_EXCL: a fixed `auth.json.tmp` would let overlapping
    // writers clobber each other's tempfile (and one writer's cleanup unlink
    // the other's pending rename) — see PR #314 review.
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      const fh = await open(tmp, "wx", 0o600);
      try {
        await fh.writeFile(JSON.stringify(merge.store, null, 2) + "\n", "utf8");
      } finally {
        await fh.close();
      }
      await rename(tmp, path);
    } catch (e) {
      try {
        await unlink(tmp);
      } catch {
        /* best-effort cleanup */
      }
      throw e;
    }
    return { ok: true, path };
  } catch (e) {
    return {
      ok: false,
      path,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}
