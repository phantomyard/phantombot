/**
 * Test-suite environment hygiene.
 *
 * Preloaded before every test file (see bunfig.toml `[test] preload`).
 *
 * Since #435 the ACTIVE PERSONA decides which config, state, database, log and
 * tmp directory phantombot reads, and `default_persona` is written to a GLOBAL
 * file under the personas root. Two consequences for the suite:
 *
 *  1. Ambient `PHANTOMBOT_PERSONA` would silently redirect every path
 *     assertion — the suite passes run by hand and fails run from inside a
 *     live phantombot turn (which always exports the persona). So it is pinned.
 *
 *  2. Any test that goes through `saveState` writes `default_persona` to the
 *     global file. Left unredirected that is the DEVELOPER'S OWN box, which is
 *     both a real-world side effect and a cross-test dependency. So the global
 *     config alone is redirected into a throwaway file for the whole run.
 *
 * The personas ROOT is deliberately NOT pinned here: many tests set
 * XDG_DATA_HOME and expect the root to follow it, which is the real default
 * behaviour and worth keeping under test.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PHANTOMBOT_PERSONA = "phantom";

delete process.env.PHANTOMBOT_PERSONAS_DIR;

const sandbox = mkdtempSync(join(tmpdir(), "phantombot-test-global-"));
process.env.PHANTOMBOT_GLOBAL_CONFIG = join(sandbox, "config.toml");
