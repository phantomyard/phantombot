# Relay-free P2P transport

PhantomChat normally discovers and exchanges encrypted messages through Nostr
relays. Phantombot also includes a preview peer-to-peer transport for direct
WebRTC delivery when both peers are reachable.

Manage the node with:

```bash
phantombot p2p --help
```

The P2P path is an additional transport, not a separate identity or trust
system. The same persona keys, allowlists, encryption, and channel routing
apply. Relay delivery remains the compatibility and recovery path when a direct
connection cannot be established.

Treat P2P as preview infrastructure: verify connectivity and relay fallback on
the actual networks where it will run. NAT, firewall, sleep, and process
lifecycle behavior cannot be proven by unit tests alone.
