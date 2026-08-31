/**
 * Test-env isolation (phantombot#473): the phantombot harness injects
 * PHANTOMBOT_PERSONA into every subprocess it spawns — including the shell
 * that runs `bun test`. Persona-aware code paths now honour that env var, so
 * an ambient value would redirect every no-flag test call at some other
 * persona's data: CI (clean env) passes while local harness-run suites fail.
 *
 * Deleting the ambient value at preload makes the suite deterministic
 * regardless of who launches it. Tests that exercise env resolution set and
 * restore PHANTOMBOT_PERSONA explicitly within their own before/after hooks.
 */
delete process.env.PHANTOMBOT_PERSONA;

/**
 * Ink renders DIFFERENTLY under CI: `is-in-ci` reads $CI at module load, and
 * ink then skips the erase-and-repaint path, writes only on unmount, and drops
 * synchronized-update wrapping. The TUI rendering tests assert on exactly that
 * machinery (clears, byte counts, frame drift), so with $CI set they assert
 * against a renderer no user ever sees — green locally, red on GitHub Actions.
 *
 * The suite therefore always runs ink's INTERACTIVE renderer. Nothing under
 * src/ reads $CI, so this only affects ink. A test that genuinely needs CI
 * detection must set $CI inside its own hooks AND import ink after doing so.
 */
delete process.env.CI;
delete process.env.CONTINUOUS_INTEGRATION;
