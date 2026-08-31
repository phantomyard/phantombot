/**
 * Colour codes out of a rendered frame.
 *
 * Whether chalk emits any is not a frame test's business, and it varies by
 * where the suite runs: a sibling suite forces `chalk.level = 3` on the shared
 * singleton to test the bars, and on GitHub Actions supports-color turns
 * colour on from $GITHUB_ACTIONS regardless. The same frame therefore reads
 * `> ^ Send` on a laptop and `> <esc>[1m<esc>[34m^<esc>[22m Send` in CI.
 * Assert on the text a user reads.
 */
export const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\u001b\[[0-9;]*m/g, "");
