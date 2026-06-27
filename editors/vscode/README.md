# phantombot for VS Code

First-party VS Code extension that brings **phantombot** — Andrew's
personality-first chat agent — into VS Code's native Chat panel as
`@phantombot`.

## How it works

The extension is a thin bridge. It does **not** build its own chat UI: it
registers a [Chat Participant](https://code.visualstudio.com/api/extension-guides/chat)
(`@phantombot`) so you get VS Code's native scrollback, history and theming for
free.

Under the hood it spawns `phantombot acp` as a subprocess and speaks
**newline-delimited JSON-RPC 2.0 over stdio** — the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP). The extension is
the *client*; phantombot is the *agent*. The lifecycle is:

```
initialize → session/new (or session/load) → session/prompt …
```

phantombot streams `session/update` notifications (assistant text chunks +
tool-call indicators) back while a prompt is in flight; the extension maps those
straight into the chat response stream.

**Persona, memory, tools and the trusted-turn perimeter all live server-side in
phantombot.** The extension never sees them — it only forwards your typed turn
and renders the streamed reply. This is the same trust model the Zed connector
uses: the local OS user who launched the editor is the principal.

## Requirements

- VS Code `^1.93.0` (Chat Participant API).
- A `phantombot` binary on the machine. The extension finds it via:
  1. the `phantombot.binaryPath` setting (absolute path), then
  2. your `PATH`, then
  3. common install locations (`~/.local/bin`, `/usr/local/bin`, `/usr/bin`,
     Homebrew on macOS; `%LOCALAPPDATA%` / `%USERPROFILE%` on Windows).

  If none resolve, the panel shows a clear error telling you to set
  `phantombot.binaryPath` — it never hangs silently.

## Settings

| Setting | Description |
|---------|-------------|
| `phantombot.binaryPath` | Absolute path to the `phantombot` binary. Empty = auto-discover. |
| `phantombot.persona` | Persona to bind the session to (passed as `--persona`). Empty = phantombot's default. |

## Usage

Open the Chat panel, type `@phantombot`, and ask. Cancelling a turn in the panel
sends `session/cancel` to the agent. Reopening the same workspace lands back in
the same phantombot conversation (memory is keyed on the workspace folder
server-side).

## Building

```bash
bun install
bun run build      # bundles src/extension.ts → dist/extension.js via esbuild
bun run typecheck
bun test ./tests
```

The ACP client, binary resolver and prompt bridge are pure modules with no
`vscode` dependency, so they run under `bun test` alongside the rest of the
phantombot suite.

## Platform support

Binary/path resolution handles linux, darwin and win32 via `process.platform`
switches. linux + darwin are exercised in CI and by hand; the win32 branch is
**implemented but untested** (no Windows host available yet).

## Roadmap

- **PR2** will bundle this extension as a `.vsix` into the phantombot binary and
  auto-install it via `reconcileEditorConnectors()` — a VS Code `EditorSpec`
  slots in beside the existing Zed one. This package is structured to make that
  a drop-in.
