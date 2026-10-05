# Complete the first run

Run Phantombot in a terminal:

```bash
phantombot
```

With an interactive terminal this opens the full-screen app. A new installation
starts the setup flow; a configured installation opens chat with the default
persona. Setup creates or imports a persona, configures a harness, and offers
optional channels, voice, and semantic memory.

You can also configure each part directly:

```bash
phantombot persona
phantombot harness
phantombot telegram
phantombot phantomchat
phantombot voice
phantombot embedding
```

Telegram and PhantomChat are optional. For a terminal-only installation, test
the configured harness with:

```bash
phantombot ask "Reply with a one-line hello"
```

To run chat channels continuously, install the platform service:

```bash
phantombot install
phantombot doctor
phantombot logs --no-follow
```

`doctor` reports channel, timer, harness, connector, and memory health. If the
configured harness is missing or unhealthy, see
[Harnesses and models](../how-to/harnesses-and-models.md) and
[Troubleshooting](../operations/troubleshooting.md).

For exact flags and subcommands, use `phantombot <command> --help` on the
version you installed.
