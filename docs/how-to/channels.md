# Connect chat channels

Phantombot can serve Telegram, PhantomChat, both, or neither. Every configured
notification source fans out independently to both channels; one does not
suppress the other.

## Telegram

```bash
phantombot telegram
```

The setup flow validates a bot token and stores the allowed owner IDs. Only
allow-listed owners are trusted. Group behavior also depends on Telegram's bot
privacy setting; see [Group chats](group-chats.md).

## PhantomChat

```bash
phantombot phantomchat
```

The setup flow creates or loads the persona's Nostr identity, prints the public
key to share, and configures relays and allowed public keys. PhantomChat uses
encrypted NIP-17 direct messages and supports text and voice.

## Run continuously

```bash
phantombot install
phantombot doctor
phantombot logs --no-follow
```

The installed service serves every configured channel. Channel messages enter
the same persona runtime as terminal and editor turns, but trust is derived
from the authenticated origin. See [Security and trust](../concepts/security-and-trust.md).
