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
