# Connect chat channels

Phantombot can serve Telegram, PhantomChat, both, or neither. Every configured
notification source fans out independently to both channels; one does not
suppress the other.

## Telegram

```bash
phantombot telegram
```

The setup flow validates a bot token and stores the allowed owner IDs. Only
allow-listed owners are trusted. With an empty allowlist anyone can talk to
the bot, but nobody is an owner: see the slash-command rule under
[Run continuously](#run-continuously). Group behavior also depends on
Telegram's bot privacy setting; see [Group chats](group-chats.md).

## PhantomChat

```bash
phantombot phantomchat
```

The setup flow creates or loads the persona's Nostr identity, prints the public
key to share, and configures relays and allowed public keys. PhantomChat uses
encrypted NIP-17 direct messages and supports text and voice. With an empty
`allowed_npubs` and trust-on-first-use off, anyone can talk to the persona but
nobody is an owner, the same rule as Telegram's empty allowlist: see the
slash-command rule under [Run continuously](#run-continuously).

For a desktop app's Scan button there is a non-interactive form:

```bash
phantombot phantomchat --list --json             # personas on this machine, with npubs
phantombot phantomchat --allow <npub> --persona <name>
```

`--list` never creates a key. `--allow` takes effect when the persona's
channel restarts (`phantombot restart`).

### Tools on the principal's PC

When the principal turns a persona's **Local tools** switch ON in the
PhantomChat desktop app, the persona can run tools on that PC:

```bash
phantombot device list                           # online PCs and their tools
phantombot device call Desk bash --args '{"command":"ls ~"}'
phantombot device call Desk read --args '{"path":"notes.txt"}' --timeout 30
```

Tools are `bash`, `read`, `write`, `edit`, `ls`, `find` and `grep`. A PC shows
up only while the app is running with the switch ON. Silence means no device,
and `call` exits 3 when the device doesn't answer. The command speaks as the
persona's own npub to its allowed npubs only, and reads answers only from them.
It works with or without a running daemon. Called from a PhantomChat group
turn, a call carries that group's id, and the app runs it only in a Session
with this persona. Untrusted (escorted) turns are refused. The protocol is
phantomchat's `docs/EXTERNAL-AI.md`.

## Run continuously

```bash
phantombot install
phantombot doctor
phantombot logs --no-follow
```

The installed service serves every configured channel. Channel messages enter
the same persona runtime as terminal and editor turns, but trust is derived
from the authenticated origin. See [Security and trust](../concepts/security-and-trust.md).

Slash commands (`/update`, `/restart`, `/reset`, `/harness`, `/status`, …) are
answered only for an authenticated owner, and that rule is the same on every
channel. A sender who is answered but is not an owner — anyone on a Telegram
bot with an empty allowlist, anyone on a PhantomChat persona with an empty
`allowed_npubs` and trust-on-first-use off, a PhantomChat bridge, or the
equivalent on any future channel — gets no command path at all: a message that
starts with `/` is treated as ordinary, screened input rather than a command.
A Telegram sender outside a non-empty allowlist is not answered at all; the
message is dropped before any of this applies.
