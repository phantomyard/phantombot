# Troubleshoot Phantombot

Start with the runtime's own health view:

```bash
phantombot doctor
phantombot logs --no-follow --lines 200
phantombot --help
```

`doctor` checks the installed service, channels, timers, harness availability,
connectors, release ring, capture health, index state, and nightly backlog.

## Harness not available

Run `phantombot harness` and confirm every configured host harness binary is on
the PATH visible to the service, not only the interactive shell. The native
harness is embedded; host Pi, Claude Code, and Codex are optional. See
[harness detection](harness-detection.md) for PATH and service-environment
details.

## Service is missing or stale

`phantombot install` is idempotent. Re-run it to repair missing units, launch
agents, scheduled jobs, completion stubs, and paths that still point at an old
binary.

## Memory is stale

```bash
phantombot memory index
phantombot memory backup --list
phantombot doctor
```

The heartbeat is mechanical and the nightly sweep retries closed days. Doctor
reports the backlog rather than silently inventing a repair. Use live `memory
--help` before restoring a backup.

## A shared checkout is busy

```bash
phantombot workspace status
```

Do not force another live turn's advisory lock. Use a fresh clone or wait for
the owning turn to finish.
