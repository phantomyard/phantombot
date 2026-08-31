/**
 * Pins what the preload (tests/testEnvIsolation.ts) guarantees to every other
 * test file. Both variables are silent, action-at-a-distance failures when
 * they leak in: PHANTOMBOT_PERSONA redirects persona-aware code at another
 * persona's data (#473), and $CI flips ink to its non-interactive renderer, so
 * the TUI rendering tests measure a renderer no user ever sees — green on a
 * laptop, red on GitHub Actions.
 */

import { expect, test } from "bun:test";
import isInCi from "is-in-ci";

test("the preload strips ambient PHANTOMBOT_PERSONA", () => {
  expect(process.env.PHANTOMBOT_PERSONA).toBeUndefined();
});

test("the preload strips $CI, so ink uses its interactive renderer", () => {
  expect(process.env.CI).toBeUndefined();
  expect(process.env.CONTINUOUS_INTEGRATION).toBeUndefined();
  // The consumer that matters: ink reads this at module load.
  expect(isInCi).toBe(false);
});
