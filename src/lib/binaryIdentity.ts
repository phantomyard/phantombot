/**
 * "Am I the real compiled phantombot binary?" — the single gate every
 * self-healing, filesystem-touching startup check hangs off.
 *
 * This is a LEAF module on purpose: it imports nothing at all. The natural home
 * would be `platform.ts`, but that already imports systemd.ts / launchd.ts /
 * taskScheduler.ts — all three of which need this gate — so putting it there
 * would close an import cycle.
 */

/** Executable basenames that mean "this process IS the shipped phantombot". */
const PHANTOMBOT_EXEC_NAMES = new Set(["phantombot", "phantombot.exe"]);

/**
 * Last path segment, splitting on BOTH separators regardless of host platform.
 *
 * Deliberately not `node:path`'s `basename`, which is bound to the host: on
 * Linux it does not treat `\` as a separator, so `basename("C:\\pb\\x.exe")`
 * returns the whole string. That would make the Windows behaviour of this gate
 * untestable from Linux/macOS CI — and an untestable Windows gate is exactly
 * how the original bug shipped and survived. `execPath` is always OS-native, so
 * accepting both separators costs nothing in production; the only divergence is
 * a POSIX file whose *name* literally contains a backslash, which is
 * pathological and, if it happened, would fail safe in the same direction as a
 * normal match.
 */
function execBasename(execPath: string): string {
  const segments = execPath.split(/[\\/]/);
  return segments[segments.length - 1] ?? "";
}

/**
 * True when `execPath` is the real compiled phantombot binary, false when we're
 * running the sources under a generic `bun`/`node` runtime (dev, `bun test`).
 *
 * This gates every check that TOUCHES THE USER'S REAL FILESYSTEM: provisioning
 * pi's capability-routing extension, registering phantombot into Zed / JetBrains
 * / VS Code, rewriting systemd units and scheduled tasks. Under `bun test` they
 * must all stay inert so a test run never writes the dev box's `~/.pi` or
 * `~/.config/zed`.
 *
 * WHY THIS EXISTS: several call sites spelled the gate inline as
 * `basename(process.execPath) === "phantombot"`. On Windows `execPath` ends in
 * `.exe`, so that comparison is NEVER true — which meant the pi extension was
 * never provisioned, the editor connectors (including our own VS Code
 * extension) were never installed, and `doctor` silently omitted its harness /
 * timers / pi-extension / editor sections. All of it failed OPEN and QUIET: the
 * code simply never ran, so there was nothing in the logs to find. Other sites
 * had already been patched ad hoc to `.startsWith("phantombot")`, so the two
 * spellings disagreed. One helper, one meaning.
 *
 * Exact-name match rather than a prefix match: `startsWith("phantombot")` also
 * matches the release download artifact (`phantombot-v1.1.194-windows-x64.exe`)
 * and the self-update leftover (`phantombot.exe.old`), neither of which is an
 * installed binary that has any business rewriting the user's editor config or
 * scheduled tasks. Comparison is case-insensitive because Windows filesystems
 * are.
 *
 * Strictly additive on Linux/macOS: `phantombot` matches exactly as it did
 * before, and `bun` / `node` still don't.
 */
export function isPhantombotBinary(
  execPath: string = process.execPath,
): boolean {
  return PHANTOMBOT_EXEC_NAMES.has(execBasename(execPath).toLowerCase());
}
