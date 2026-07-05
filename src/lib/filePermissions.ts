/**
 * Cross-platform "lock this file down to just me" primitive.
 *
 * On POSIX the caller already writes sensitive files at mode 0o600, and the
 * kernel enforces it — nothing to do here, so this is a no-op. On Windows the
 * POSIX permission bits passed to writeFile are IGNORED: a freshly created file
 * inherits its parent directory's ACL, which on a shared machine can grant read
 * access to other principals (BUILTIN\Users, etc.). For the persona's crown
 * jewel — identity.json, which holds the nsec every vault secret is encrypted
 * under — that is not acceptable, so we apply an explicit restrictive ACL.
 *
 * The Windows lockdown does two things via `icacls`:
 *   /inheritance:r   — remove all INHERITED ACEs (drops whatever the parent dir
 *                      would have granted: Users, Authenticated Users, etc.)
 *   /grant:r <me>:F  — replace any explicit grant for the current user with a
 *                      single Full-control ACE.
 * The net DACL is exactly one ACE: the current user, full control. Everyone
 * else — including standard users on the same box — is denied by absence.
 *
 * Fails CLOSED: if the current account can't be resolved or icacls errors, this
 * THROWS. Callers apply it to a tempfile BEFORE hard-linking it into place, so a
 * throw means no identity.json is ever created — far better than silently
 * persisting the nsec in a file other users could read.
 */

/**
 * Resolve the current user's SID (e.g. `S-1-5-21-…-1001`) and grant by SID
 * rather than by name. Account NAMES are ambiguous on Windows: on a workgroup
 * (non-domain) machine `%USERDOMAIN%` is the workgroup name `WORKGROUP`, which
 * is NOT a valid account authority, so `icacls /grant WORKGROUP\user` fails with
 * "No mapping between account names and security IDs". The SID always maps and
 * is immune to renamed accounts and localized principal names.
 */
export function currentUserSid(): string {
  const res = Bun.spawnSync(["whoami", "/user", "/fo", "csv", "/nh"]);
  const out = new TextDecoder().decode(res.stdout).trim();
  // Output shape: "DOMAIN\user","S-1-5-21-…"
  const m = out.match(/(S-1-[0-9-]+)/);
  if (!m) {
    throw new Error(`could not resolve current user SID (whoami: ${out || "no output"})`);
  }
  return m[1]!;
}

/**
 * Restrict `path` so ONLY the current user can access it. No-op on POSIX (the
 * file's mode 0o600 already governs); applies an owner-only ACL on Windows.
 * Throws on Windows if the lockdown cannot be verified to have succeeded.
 */
export function restrictFileToCurrentUser(path: string): void {
  if (process.platform !== "win32") return;

  // Grant by SID (`*S-1-…`) — see currentUserSid for why names are unsafe.
  const sid = currentUserSid();
  const res = Bun.spawnSync([
    "icacls",
    path,
    "/inheritance:r",
    "/grant:r",
    `*${sid}:(F)`,
  ]);
  if (res.exitCode !== 0) {
    const stderr = new TextDecoder().decode(res.stderr).trim();
    const stdout = new TextDecoder().decode(res.stdout).trim();
    throw new Error(
      `icacls lockdown failed for ${path}: ${stderr || stdout || `exit ${res.exitCode}`}`,
    );
  }
}
