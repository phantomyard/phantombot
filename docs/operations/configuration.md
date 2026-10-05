# Configure Phantombot

Phantombot separates host settings from persona settings. The host config owns
shared runtime choices; each persona owns identity, channels, memory, harness
overrides, and credentials.

Configuration follows this precedence:

1. Explicit environment overrides.
2. Persona-local configuration for persona-scoped settings.
3. Host configuration.
4. Built-in defaults.

The default XDG roots are:

- configuration: `~/.config/phantombot`
- data: `~/.local/share/phantombot`
- state: `~/.local/state/phantombot`

Windows deliberately uses the same home-relative layout under `%USERPROFILE%`.
`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `XDG_STATE_HOME` relocate the roots.

Prefer the supported setup commands over hand-editing TOML:

```bash
phantombot persona
phantombot harness
phantombot telegram
phantombot phantomchat
phantombot voice
phantombot embedding
phantombot decision-model
```

Credentials are not ordinary configuration. Store them with `phantombot vault`.
The legacy `phantombot env` command is only a compatibility alias for the
encrypted vault.

Run `phantombot doctor` after a configuration change. Some platform changes
also reconcile or restart the installed service; the interactive UI states the
consequence before applying it.
