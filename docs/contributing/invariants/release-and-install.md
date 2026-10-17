# Release and install — contributor invariants

Part of the phantombot contributor guide: the release pipeline and rings, versioning, the installers, `phantombot update`. The index of every invariant is in [`/AGENTS.md`](../../../AGENTS.md). Numbers are stable identifiers — code comments and tests cite them — so a new rule takes the next free number and nothing is renumbered or reused (the one-time renumbering into 71–73 and 77 is recorded in AGENTS.md). Each rule records a real incident; a deliberate, documented trade-off is not a defect.

## Release pipeline

Every runtime-affecting merge to `main` auto-releases `v1.1.<RUN_NUMBER>` as a
**prerelease**. Docs-only merges run a lightweight classifier and no build or
release job. The workflow at `.github/workflows/release.yml`:

1. Triggers on `push: main` (branch protection means a push IS a merge), then a
   lightweight fail-safe classifier skips the release job for a narrow
   denylist of docs/website surfaces. It checks old and new names for renames
   and defaults to releasing if GitHub's file listing fails. NOT
   `pull_request: closed` — a fork-merged PR runs that with a read-only token and
   `gh release create` 403s.
2. Checks out `github.sha` (the merge commit), so the tag pins to exactly the
   code that merged.
3. Runs `bun tsc --noEmit` and `bun test` as gates.
4. `sed -i "s/0.1.0-dev/1.1.${RUN_NUMBER}/" src/version.ts` (replaces only the
   literal placeholder, preserves the doc comment block).
5. Regenerates + version-stamps the embedded VS Code extension.
6. Cross-compiles linux x64-baseline/arm64, darwin x64/arm64, windows x64/arm64.
7. Computes `SHA256SUMS`.
8. `gh release create v1.1.<RUN_NUMBER> --prerelease --target <sha> …`.

**Release rings (#432).** `--prerelease` in step 8 is the whole gate. GitHub's
`/releases/latest` excludes prereleases, and that is what a `stable` host
resolves (`src/lib/githubReleases.ts`); a host with `update_channel = "preview"`
resolves the `/releases` LIST instead and takes its newest non-draft entry. So a
merge reaches only the preview ring until a human runs the
`.github/workflows/promote.yml` workflow_dispatch, which flips
`--prerelease=false --latest` on an **existing** release.

Four things here look like tidy-up candidates and are not:

- **Promotion must never rebuild.** The point of a ring is that the bytes the
  fleet installs are the bytes that soaked. A promotion that rebuilt would ship
  an artifact nobody ran, and the soak would be theatre.
- **CI must not decide stable.** Green tests are the bar for MERGING. If they
  were also the bar for promotion the two rings would be one ring. Stable means
  a human watched a real host run it.
- **The updater compares versions for EQUALITY, not `>`** (`src/cli/update.ts`).
  This is what makes rollback free: a host stranded on preview `1.1.291` flips
  `update_channel` back to `stable` and installs `1.1.280`, a LOWER number.
  Turning that into a "newer than" compare strands every preview host on
  whatever build broke; `tests/cli-update.test.ts` has a test that goes red if
  you do.
- **An unrecognised `update_channel` falls back to `stable`, not preview**
  (`resolveUpdateChannel` in `src/config.ts`). A typo must never opt a box into
  a ring its operator did not choose.

`phantombot update`, the `/update` chat command and the heartbeat update-check
all resolve through the host's configured ring, and `phantombot doctor` reports
it — a bug report that does not say which ring it came from is uninterpretable
once `latest` stops meaning "newest build".

**Versioning is intentionally not semver.** `1.1.<RUN_NUMBER>` — patch is the
release workflow's monotonic run number, not semantic impact and not the PR
number (PR numbers can regress; the PR is recorded in the release title/notes).
Don't bolt semver-aware logic on (`phantombot update --major-only` etc.); the
version string can't carry that information.

## Invariants

<a id="inv-1"></a>
### 1. `bun-linux-x64` instead of baseline

— SIGILLs on pre-AVX2 hardware. Use `bun-linux-x64-baseline`. Documented at the top of `.github/workflows/release.yml`.

<a id="inv-2"></a>
### 2. `echo … > src/version.ts` in CI

— would clobber the comment block. Use `sed -i "s/0.1.0-dev/$VERSION/" src/version.ts` instead. The placeholder literal must round-trip exactly; if you change `version.ts`, also update the sed pattern in the workflow.

<a id="inv-3"></a>
### 3. `sudo cp` to install someone's binary

— leaves `.bak` root-owned, blocks future `phantombot update` from the unprivileged user. Use `sudo install -o <user> -g <group> -m 755 …`. Documented in PR #47's repro.

<a id="inv-4"></a>
### 4. `copyFile` over an existing foreign-owned file

— fails with EACCES because `O_TRUNC` checks the existing file's mode. `applyUpdate` unlinks `.bak` first; if you add similar copy logic, do the same.

<a id="inv-8"></a>
### 8. `install.sh` piped to `sh` runs without a TTY

— interactive @clack TUIs would misbehave. The script detects this with `[ -t 0 ] && [ -t 1 ]` before launching the persona TUI, and prints the next-step hint instead. If you add interactive setup steps to the install flow, repeat the check.

<a id="inv-12"></a>
### 12. `GITHUB_TOKEN` for `phantombot update` isn't always safe to send.

GitHub App installation tokens are scoped to a single org's repos; using one against the public `phantomyard/phantombot` releases endpoint returns 401 even though the endpoint is anonymously reachable. `findLatestRelease` in `src/lib/githubReleases.ts` therefore retries once *without* the auth header on 401/403 before failing, and the final error mentions org-scoping explicitly. If you add another auth'd GitHub API call (e.g. for changelog fetch, asset metadata, etc.), reuse the `buildHeaders(withAuth)` helper and replicate the unauth-retry path — otherwise users with org-scoped tokens hit a dead end on what should be a public read. See issue #115 / PR #120.

<a id="inv-50"></a>
### 50. A progress tick must be earned. If a checklist step cannot fail, it is not a step — delete it or make it real.

`install.sh` / `install.ps1` print `Inspecting System / Downloading Binary / Installing Now / Verifying`, and "Verifying" was an `if` block with an empty body followed by an unconditional green `✓` — it would have reported success for a zero-byte file, a wrong-arch asset or a broken macOS codesign, which is worse than not checking, because the user now has a receipt. Verifying executes the installed binary (`--version`) and prints a red `✗` plus the captured output on failure. The same rule retired `$PB_BIN install >/dev/null 2>&1 || true`: a service registration whose failure is discarded is indistinguishable from one that worked until the next reboot, so it is now its own reported step and the closing line degrades to "the background service is not" rather than claiming success. Tests: `tests/install-sh.test.ts` (each assertion proven against the pre-fix script).

<a id="inv-53"></a>
### 53. `install.ps1` must parse and run under Windows PowerShell 5.1 — that is the floor a fresh Windows box ships, and no Linux check can see it.

Three faults shipped past a fully green CI at once (PR #539): `[switch]$DryRun` alongside `[switch]$dryrun` is a `DuplicateFormalParameter` parse error because PowerShell identifiers are case-insensitive; a BOM-less file is decoded as the ANSI codepage by 5.1, so the banner's box-drawing glyphs corrupt mid-string and take the parse with them (**install.ps1 must keep its UTF-8 BOM**); and `"$c123$boldLearns ..."` reads as a variable named `$boldLearns`, which `Set-StrictMode` turns into a hard error — interpolate as `${bold}`. 5.1 also renders host output in the console OEM codepage, so `[Console]::OutputEncoding` is set to UTF-8 before the banner or every glyph arrives as `?`. The gate is real execution: CI's `test-windows` job parses the script with the 5.1 parser and runs it `-DryRun`, and `tests/install-ps1.test.ts` mirrors the static half locally. **The BOM cuts both ways: it is required on disk and fatal through `iex`.** `iwr -useb ... | iex` hands the BOM to the parser as a leading U+FEFF, and 5.1 then loses the `<#` opener, parses the help text as code (`Unexpected token 'Clears' ...`) and rejects `[CmdletBinding()]` for not being first - a user on a fresh Windows box hit exactly this from the command on the website. No layout of the script survives it (BOM + blank line, BOM + `#` line: both still fail on `[CmdletBinding()]`, verified on 5.1.26100), so the *published command* is what has to change: every doc shows `iex ((iwr -useb ...).Content.TrimStart([char]0xFEFF))`, `tests/install-ps1.test.ts` fails if any doc pipes the raw download into `iex`, and CI parses the BOM-led string to prove it still needs stripping.
