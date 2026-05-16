/**
 * The single source of truth for phantombot's version string.
 *
 * Local development always reports the `-dev` suffix. CI replaces the
 * literal `0.1.0-dev` below with `1.1.<RUN_NUMBER>` (sed, not full-file
 * overwrite — see .github/workflows/release.yml) before
 * `bun build --compile`, so the released binary prints its real version.
 *
 * **Versioning scheme is intentionally NOT semver.** `1.1.<RUN_NUMBER>`
 * uses the GitHub Actions per-workflow `run_number` as the patch
 * component because every merged PR auto-releases. `run_number` is a
 * monotonic counter scoped to the release workflow — it only ever
 * increases, so the latest release is always the one with the highest
 * number, and every binary maps 1:1 to exactly one Actions run.
 *
 * We deliberately moved off `<PR_NUMBER>` because PR numbers can
 * regress (PR #50 lands before PR #49) and were producing confusing
 * "version went backwards" semantics. The originating PR number is
 * still preserved in the release title and notes for audit purposes —
 * it's just not in the version string.
 *
 * Why `1.1.<N>` and not `1.0.<N>`: the first run-numbered release
 * (run_number=64) collided with the old PR-numbered v1.0.64 tag,
 * so we bumped minor once to escape the overlap with the PR-era
 * tags (which went up to ~v1.0.109). Don't bump again — run_number
 * only grows from here, so v1.1.<N> is safe to infinity.
 *
 * There is no path to bumping major or minor without breaking the
 * scheme, and run-numbered patches are not ordered by semantic impact
 * (1.1.42 is a "patch" of 1.1.41 only by coincidence). Don't bolt
 * semver-aware logic onto `phantombot update` (e.g. "this is a major
 * upgrade, read the release notes first") — the version string can't
 * carry that information here.
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
