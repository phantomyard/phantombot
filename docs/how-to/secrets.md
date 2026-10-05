# Store secrets safely

Credentials belong in the persona-scoped encrypted vault. They do not belong
in notes, task prompts, shell history, TOML files, or a legacy `.env` file.

Pipe values through stdin so the secret does not appear in the process list:

```bash
printf '%s' "$API_KEY" | phantombot vault set API_KEY
phantombot vault list
phantombot vault unset API_KEY
```

`vault list` prints names only. Avoid `vault get` in an interactive terminal
because the value is printed to scrollback. Empty stdin is rejected unless an
empty value is explicitly requested.

Each persona has its own vault. The encryption key is derived from that
persona's identity, so `identity.json` and the vault database must be backed up
together. Losing or replacing the identity makes the stored secrets
unrecoverable.

Phantombot injects the active persona's vault into the harness environment at
spawn time. A newly saved credential is therefore available to the next turn
without copying it into global `process.env` or restarting the service.
