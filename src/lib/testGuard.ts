/**
 * The test-side blast-radius guard (issue #632, generalising the state.json
 * guard from the 2026-09-01 incident).
 *
 * state.json was the only persistent store a test run refused to write — but
 * a leak into the task DB, the memory DB, the vault, a persona dir or a
 * config.toml is just as silent and just as permanent, and none of those had
 * a guard. Every choke point that OPENS or CREATES one of those stores calls
 * `assertTestWritable`, so a test that resolves a store path at the real host
 * fails loud at the write site instead of mutating a live install with a
 * green run as the only evidence.
 *
 * Armed only by tests/testEnvIsolation.ts (the bun `preload`), which sets
 * PHANTOMBOT_TEST_ISOLATION_ROOT — so this is inert in every shipped binary
 * and costs production nothing but one env read.
 *
 * Allowed: anything under the isolation root, or under the system temp dir —
 * the many suites that pin their own `mkdtemp` path must keep working. What
 * is forbidden is precisely the default resolution into a real XDG dir.
 */

import { resolve, sep } from "node:path";
import { tmpdir } from "node:os";

export function assertTestWritable(path: string, what = "path"): void {
  const root = process.env.PHANTOMBOT_TEST_ISOLATION_ROOT;
  if (!root) return;
  // bun:sqlite's in-memory sentinel is not a path; resolving it would point
  // at the cwd. Nothing it writes survives the connection, so it is safe.
  if (path === ":memory:") return;
  const target = resolve(path);
  const allowed = [root, tmpdir()].map((d) => resolve(d) + sep);
  if (allowed.some((prefix) => target.startsWith(prefix))) return;
  throw new Error(
    `refusing to write ${what} outside test isolation: ${target}\n` +
      "A test reached a persistent-store code path while it resolved to the " +
      "real host (ambient XDG root, PHANTOMBOT_STATE, or an explicit path " +
      "into the developer's home). Point it at a temp dir in the test's own " +
      "hooks — or at the PHANTOMBOT_TEST_ISOLATION_ROOT the preload provides " +
      "— and restore any env you override.",
  );
}
