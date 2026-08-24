/**
 * Is a harness path persisted in `state.json` usable on THIS platform?
 *
 * Why this exists (issue #450). `loadConfig` reads `state.harness_bins.<id>`
 * AHEAD of the bare-name default, so a once-resolved absolute path is sticky:
 *
 *   env -> config.toml -> state.harness_bins -> "claude"
 *
 * `state.json` lives in the data dir, NOT in config.toml. That means deleting
 * or rewriting config.toml does not clear it, and there is no documented knob
 * that does — so a path resolved under a DIFFERENT runtime on the same machine
 * (a WSL or Git-Bash run writing `/bin/claude`, then a native Windows run
 * reading it back) survives every remedy an operator would reasonably try. To
 * the user it presents exactly as a bad hardcoded default: "phantombot insists
 * my claude is at /bin/claude and I never configured that."
 *
 * The trap is that `path.win32.isAbsolute("/bin/claude") === true`, so a POSIX
 * path looks perfectly well-formed to the Windows resolver — it simply never
 * resolves, and the harness reports NOT FOUND.
 *
 * The rule is deliberately a PURE STRING TEST on path *flavour*, not a
 * filesystem check: a persisted bin that cannot be a path on this platform is
 * discarded so the chain falls through to the bare-name default, which the
 * search-path sweep can then find. A well-formed path that merely doesn't
 * exist right now is KEPT — that's a missing install, and reporting it against
 * the configured path is the honest diagnostic. This function decides shape
 * only; existence is `resolveHarnessBinary`'s job.
 *
 * Note the asymmetry is real, not defensive coding: a drive-letter path is
 * meaningless on POSIX, and a POSIX-rooted path on Windows is the actual bug
 * from #450.
 */

const DRIVE_LETTER = /^[A-Za-z]:[\\/]/;

export function isUsablePersistedBin(
  bin: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (bin.length === 0) return false;

  if (platform === "win32") {
    // Windows-absolute means a drive letter (C:\...) or a UNC root (\\host\share).
    // A leading "/" or a lone "\" is a POSIX/WSL path that will never resolve.
    if (DRIVE_LETTER.test(bin)) return true;
    if (bin.startsWith("\\\\")) return true;
    return !(bin.startsWith("/") || bin.startsWith("\\"));
  }

  // POSIX: a drive-letter or UNC path came from a Windows run and is unusable.
  if (DRIVE_LETTER.test(bin)) return false;
  if (bin.startsWith("\\\\")) return false;
  return true;
}

/**
 * `bin` if it is usable on this platform, otherwise undefined — shaped for the
 * `??` precedence chain in `loadConfig` so an unusable persisted value falls
 * through to the next source instead of poisoning it.
 */
export function usablePersistedBin(
  bin: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (bin === undefined) return undefined;
  return isUsablePersistedBin(bin, platform) ? bin : undefined;
}
