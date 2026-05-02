/**
 * The single source of truth for phantombot's version string.
 *
 * Local development always reports the `-dev` suffix. CI replaces the
 * literal `0.1.0-dev` below with `1.0.<PR_NUMBER>` (sed, not full-file
 * overwrite — see .github/workflows/release.yml) before
 * `bun build --compile`, so the released binary prints its real version.
 *
 * **Versioning scheme is intentionally NOT semver.** `1.0.<PR_NUMBER>`
 * uses the GitHub PR number as the patch component because every merged
 * PR auto-releases. There is no path to bumping major or minor without
 * breaking the scheme, and PR-numbered patches are not ordered by
 * semantic impact (1.0.42 is a "patch" of 1.0.41 only by coincidence).
 * Don't bolt semver-aware logic onto `phantombot update` (e.g. "this
 * is a major upgrade, read the release notes first") — the version
 * string can't carry that information here.
 *
 * **Contract for the placeholder**: the literal `"0.1.0-dev"` below
 * must round-trip exactly. The CI sed substitution targets that string;
 * if you change the literal, also change the sed pattern.
 *
 * `phantombot update` reads VERSION from this constant to decide whether
 * a newer release is available, so anything that bakes a wrong value
 * here will produce wrong update prompts.
 */

export const VERSION = "0.1.0-dev";
