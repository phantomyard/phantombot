# Coordinate concurrent work

Phantombot can run an interactive channel turn while scheduled work fires in a
separate process. Three mechanisms keep that understandable.

## Turn registry

Every active turn registers its persona and conversation for its lifetime.
The scheduler defers a wake when the principal is already talking to that
persona, so background work does not race the active conversation.

Scheduled wakes are deferred while a turn is live and for three minutes after
an interactive turn ends. Deferral is bounded at 15 minutes; after that the
task runs with a sibling-turn notice instead of being postponed forever.
Command-backed tasks are deferred too because they may invoke `phantombot ask`.
Deferral does not advance the task's run count or reschedule the task row.

`PHANTOMBOT_TURN_REGISTRY=0` disables registration, deferral, and sibling
notices. `PHANTOMBOT_TURN_REGISTRY_DIR` relocates the registry from
`$XDG_STATE_HOME/phantombot/turns`; use it for isolated tests, not to split one
live installation across registries.

## Background digests

Work completed outside the current conversation is summarized into the next
interactive turn. The summary is bounded, sanitized, and treated as data. It
helps the persona avoid repeating completed work without granting authority to
the background trigger.

`PHANTOMBOT_TURN_DIGEST=0` disables digest writing and injection.
`PHANTOMBOT_TURN_DIGEST_DIR` relocates the default
`$XDG_STATE_HOME/phantombot/digests` directory.

## Workspace locks

Claim a shared checkout before changing branches, committing, rebasing, or
building in it:

```bash
phantombot workspace lock /absolute/path --purpose "review PR 123"
phantombot workspace status
phantombot workspace unlock /absolute/path
```

Locks are advisory. They cannot stop a process from writing, so every turn must
honor them. A lock held by another live turn means use a new checkout; stale
claims expire after their owner disappears.

`PHANTOMBOT_WORKSPACE_LOCKS=0` disables claims.
`PHANTOMBOT_WORKSPACE_LOCK_DIR` relocates the default
`$XDG_STATE_HOME/phantombot/workspaces` directory. On macOS and Windows,
`PHANTOMBOT_PROCESS_START_PROBE=0` disables the helper-based process identity
probe and falls back to pid-only liveness checks.

## Notifications

Background tasks are silent unless something material needs the owner. A
notification fans out independently to every configured owner on Telegram and
PhantomChat:

```bash
phantombot notify --message "The release failed verification"
```
