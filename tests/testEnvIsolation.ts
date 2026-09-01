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

/**
 * State isolation (2026-09-01 incident). `state.json` resolves to
 * $XDG_DATA_HOME/phantombot/state.json unless PHANTOMBOT_STATE says
 * otherwise, so ANY test that reaches a code path writing state — directly or
 * five frames deep inside a CLI entry point it is exercising for another
 * reason — rewrites the LIVE host's state.json. Two did:
 * `cli-persona-new.test.ts` (runPersonaNew → adoptAsDefaultIfMissing) set the
 * rig's default_persona to a real persona, and `connectors-acp-server.test.ts`
 * (runAcpServer → healDefaultPersonaIfBroken) then set it to its FIXTURE
 * persona name. The rig's CLI default and `phantombot doctor` broke, and a
 * heartbeat timer was armed for a persona that does not exist — from a test
 * run, on a machine nobody was testing.
 *
 * Per-test opt-in is the wrong shape for this: 23 of the suite's files set
 * PHANTOMBOT_STATE and the two that bit us were exactly the ones that had no
 * reason to think they needed it. Isolation therefore defaults ON for the
 * whole suite here, and `??=` means a test that pins its own path still wins
 * (and, crucially, restoring a saved-then-deleted value lands back on THIS
 * path rather than the live one).
 *
 * The paired guard in src/state.ts turns the remaining hole — a test that
 * clears the var outright — from a silent host mutation into a loud failure.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isolationRoot = mkdtempSync(join(tmpdir(), "phantombot-test-isolation-"));
process.env.PHANTOMBOT_TEST_ISOLATION_ROOT = isolationRoot;
process.env.PHANTOMBOT_STATE ??= join(isolationRoot, "state.json");
process.env.PHANTOMBOT_STATE_AUDIT ??= join(isolationRoot, "state-audit.log");
process.env.XDG_DATA_HOME ??= join(isolationRoot, "xdg-data");

// The suite already leaks fixture dirs; this one cleans up after itself.
process.on("exit", () => {
  try {
    rmSync(isolationRoot, { recursive: true, force: true });
  } catch {
    // a leaked temp dir is not worth failing a green run over
  }
});
