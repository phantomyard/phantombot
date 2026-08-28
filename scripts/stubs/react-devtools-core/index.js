// No-op stub for `react-devtools-core`.
//
// Ink's reconciler imports this module behind a `process.env.DEV === "true"`
// guard. Bun's bundler follows the import STATICALLY regardless of the guard,
// so `bun build --compile` fails with `Could not resolve: "react-devtools-core"`
// unless something answers for the name.
//
// `--external react-devtools-core` is NOT the fix: the build then succeeds and
// the binary dies at RUNTIME with `Cannot find package` from inside `/$bunfs/`,
// because the standalone runtime resolves externals eagerly. Aliasing the name
// to this stub (see the `react-devtools-core` entry in package.json
// dependencies) resolves it at build time to something that costs nothing.
//
// Nothing here is ever called in a shipped binary — the guard is false — so the
// exports exist only to satisfy the shape ink expects if it ever were.
function connectToDevTools() {}
function connectWithCustomMessagingProtocol() {
  return function disconnect() {};
}
function initialize() {}

module.exports = {
  connectToDevTools,
  connectWithCustomMessagingProtocol,
  initialize,
};
