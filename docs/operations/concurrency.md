# Coordinate concurrent work

Phantombot can run an interactive channel turn while scheduled work fires in a
separate process. Three mechanisms keep that understandable.

## Turn registry

Every active turn registers its persona and conversation for its lifetime.
The scheduler defers a wake when the principal is already talking to that
persona, so background work does not race the active conversation.

## Background digests

Work completed outside the current conversation is summarized into the next
interactive turn. The summary is bounded, sanitized, and treated as data. It
helps the persona avoid repeating completed work without granting authority to
the background trigger.

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

## Notifications

Background tasks are silent unless something material needs the owner. A
notification fans out independently to every configured owner on Telegram and
PhantomChat:

```bash
phantombot notify --message "The release failed verification"
```
