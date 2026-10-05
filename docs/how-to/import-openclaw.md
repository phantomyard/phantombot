# Import a persona from OpenClaw

Use the persona import flow rather than copying individual files:

```bash
phantombot persona --help
```

The importer understands OpenClaw persona files and migrates supported channel
configuration into a Phantombot persona. It does not overwrite existing
persona content silently. Review the imported identity, tool guidance, memory,
and channel allowlists before starting the service.

Credentials should be written to the new persona's encrypted vault after the
import. Do not carry a plaintext `.env` forward. If the source persona has
scheduled work, recreate it with `phantombot task` so every task is visible in
the SQLite task store and audit log.

Finish by running:

```bash
phantombot harness
phantombot doctor
phantombot ask "Confirm which persona you are"
```
