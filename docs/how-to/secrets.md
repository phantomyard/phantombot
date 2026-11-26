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
without any manual environment copying or a service restart.

## Give a secret to one command only

`vault exec` runs one command with only the secrets you name added to its
environment, and prints its output — never the values (any value that turns up
in the output is shown as `«NAME»`):

```bash
phantombot vault exec --secrets GITHUB_CLASSIC_TOKEN 'gh pr view 820'
```

Every other vault secret is removed from that command's environment first. The
agent's `pbot_vault` tool has the same action (`{action:"exec", secrets,
command}`); the `get` action stays for when you explicitly ask for a value.

## Limit what reaches the agent's environment

By default every vault secret is in the agent's environment, so a bare `env`
in a turn prints all of them. To shrink that, list the names the agent may
still see in `config.toml`:

```toml
[vault]
agent_env = ["GITHUB_CLASSIC_TOKEN"]   # [] = none
```

Everything else then reaches commands only through `vault exec`. Phantombot's
own features are unaffected: voice/audio, command tasks, Telegram, embeddings,
the decision model and provider/platform configuration all read the active
persona's vault directly, including when it is the startup persona. They do not
depend on the environment mirror. A harness's own provider key is still set on
its process explicitly.

For backward compatibility, an explicit shell or systemd secret override still
works through the shared guarded resolver. A value injected from a different
persona's vault is never treated as such an override. Leaving `agent_env` out
keeps the old agent-delivery behaviour.
