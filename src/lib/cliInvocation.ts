/**
 * Tiny, dependency-free helpers for reasoning about how the CLI was invoked,
 * used by the entrypoint (src/index.ts) BEFORE the Citty dispatcher runs.
 *
 * Kept in its own module (rather than inline in index.ts) so it can be unit
 * tested — importing index.ts would auto-run `runMain`, which we don't want in
 * a test process.
 */

/**
 * True when the invocation is a read-only one that must not touch disk or
 * provision any state: `--help`/`-h`, `--version`/`-v`, the `help` subcommand,
 * the hidden `_complete` tab-completion backend, or a bare call with no
 * subcommand (which just prints usage). CI uses `--help`/`--version` as "does
 * the binary run?" smoke tests, and every <TAB> spawns `_complete`, so these
 * must be pure — no vault migration, no persona creation.
 *
 * @param argv the full `process.argv` (element 0 = runtime, 1 = script).
 */
export function isReadOnlyInvocation(argv: string[]): boolean {
  const args = argv.slice(2);
  if (args.length === 0) return true; // bare `phantombot` → usage text
  const first = args[0];
  return (
    first === "--help" ||
    first === "-h" ||
    first === "--version" ||
    first === "-v" ||
    first === "help" ||
    first === "_complete"
  );
}

/**
 * True for exactly `phantombot --version` — the form citty answers. citty
 * prints it through consola, which tags non-TTY output as `[log] 1.1.N`;
 * package managers (mise's registry test) and scripts parse that stdout, so
 * the entrypoint answers this one itself with the bare version.
 */
export function isVersionInvocation(argv: string[]): boolean {
  const args = argv.slice(2);
  return args.length === 1 && args[0] === "--version";
}
