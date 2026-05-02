/**
 * The single source of truth for phantombot's version string.
 *
 * Local development always reports the `-dev` suffix. CI overwrites this
 * file before `bun build --compile` with `1.0.<PR_NUMBER>` so the binary
 * baked into a GitHub Release prints its real version. See
 * .github/workflows/release.yml.
 *
 * `phantombot update` reads VERSION from this constant to decide whether
 * a newer release is available, so anything that bakes a wrong value
 * here will produce wrong update prompts.
 */

export const VERSION = "0.1.0-dev";
