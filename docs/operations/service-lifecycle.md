# Manage the service

Install the background service after first-run setup:

```bash
phantombot install
```

The same commands work on every supported platform:

```bash
phantombot start
phantombot stop
phantombot restart
phantombot logs
phantombot logs --no-follow --lines 200
phantombot uninstall
```

Linux uses systemd user units, macOS uses a LaunchAgent, and Windows uses
per-user Task Scheduler jobs. `stop` disables the platform's keep-alive path so
the service stays down; `start` reverses that state.

Linux logs go to journald. macOS and Windows use rotating files under the
platform log directory. The heartbeat rotates file logs every 30 minutes when
they exceed the configured size. `phantombot doctor` reports the effective
service state and log location.

`PHANTOMBOT_SANDBOX=1` suppresses service mutations for development checkouts.
Do not set it on the production daemon: updates and restarts would report a
suppressed success while leaving the service unchanged.

`phantombot install` is idempotent and is the recovery command when service
definitions are missing or point at an old binary.
