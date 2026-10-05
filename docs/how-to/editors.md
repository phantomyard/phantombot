# Use Phantombot from an editor

Phantombot exposes the same persona through the Agent Client Protocol (ACP).
Install the integration for the editor you use:

```bash
phantombot acp install vscode
phantombot acp install zed
phantombot acp install jetbrains
```

VS Code uses the bundled first-party extension. Zed and JetBrains receive the
required ACP settings. The editor starts Phantombot over stdio and supplies the
workspace context for that session.

Editor turns use the persona's normal identity, memory, harness chain, and
vault. Local ACP is a trusted surface because the user already controls the
account and workspace. A remote message quoted inside the editor remains data;
it does not inherit that trust.

Use `phantombot acp --help` for current install and server options. If an
editor cannot start the agent, run `phantombot doctor`, confirm the installed
binary is on the editor's PATH, and inspect the editor's own ACP log.
