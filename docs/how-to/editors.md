# Use Phantombot from an editor

Phantombot reaches editors two ways, and the difference matters:

- **As an ACP agent.** The editor spawns `phantombot acp` over stdio and talks
  Agent Client Protocol to it. VS Code, Zed, and every JetBrains IDE work this
  way.
- **As a model provider.** OpenCode runs its own agent, so it cannot consume an
  external ACP agent. Phantombot therefore registers itself as a provider and
  appears in OpenCode's model picker instead.

## Install

```bash
phantombot acp install vscode
phantombot acp install zed
phantombot acp install jetbrains
phantombot acp install opencode
```

VS Code uses the bundled first-party extension. Zed and JetBrains receive the
required ACP settings. All four are idempotent and merge rather than overwrite,
and each backs up the file it touches.

## OpenCode (desktop and CLI)

`phantombot acp install opencode` writes a `phantombot` provider into your
OpenCode config (`opencode.json`, JSONC-safe, backed up first):

- **One model per persona.** The provider treats the model id as the persona
  name and runs `phantombot acp --persona <model id>`, so
  `Phantombot — max` and `Phantombot — omar` are two independent phantoms. Two
  OpenCode sessions on the same model share that persona's memory and vault.
- **No daemon, no port, no token.** The provider package spawns the agent per
  conversation over stdio, so it also works while the Phantombot service is
  down. There is nothing listening, so there is no local port to protect and no
  bearer token to leak.
- **Attachments.** The provider declares its input capabilities, so OpenCode
  hands it PDFs and images instead of refusing them upstream.
- **Scope it.** `phantombot acp install opencode --persona max` exposes a single
  persona; omit the flag and every persona in the persona directory becomes a
  model.

## What the editor session gets

Editor turns use the persona's normal identity, memory, harness chain, and
vault. A local ACP or provider session is a trusted surface because the process
is started by the signed-in OS user, who already reads and writes the persona
directory — there is no privilege boundary for the threat judge to defend. A
remote message quoted inside the editor stays data; it does not inherit that
trust. See [security and trust](../concepts/security-and-trust.md).

Use `phantombot acp --help` for current install and server options. If an
editor cannot start the agent, run `phantombot doctor`, confirm the installed
binary is on the editor's PATH, and inspect the editor's own ACP log. For
OpenCode, check that `providers.phantombot` is present in `opencode.json` and
that the `command` setting points at a binary that still exists — a moved
install leaves the provider pointing at nothing.
