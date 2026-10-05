# Decision model

Phantombot can use an optional typed decision backend for two narrow choices:

1. Score untrusted input for the threat screen.
2. Choose the primary or coding model before a Pi turn.

The current built-in provider is TypeSafe Jev. A decision model is not a
harness: it cannot write free text, use tools, or answer the user. It receives
a bounded state and returns typed choices or calibrated scores.

Configure it with:

```bash
phantombot decision-model
```

`phantombot jev` remains a deprecated alias. The user-facing concept is the
decision-model slot; the on-disk `[jev]` block and `PHANTOMBOT_JEV_*` variables
remain compatibility contracts.

## Failure behavior

The decision model is optional and every failure falls back:

- the threat screen uses the tool-less harness judge;
- model routing uses the local keyword scorer.

Timeouts, missing keys, invalid responses, and provider errors are recorded in
a persona-local health ledger without storing the screened text. `phantombot
doctor` reports degraded use and expires old failures at report time.

The threat score uses the maximum of two views in one request: a defender frame
and a red-team frame. The calibrated default threshold belongs to this backend
and is intentionally independent from the harness judge's threshold.

## Provider boundary

Built-in transports know their endpoint. A custom provider must declare an
explicit base URL; Phantombot never guesses an endpoint for an unknown provider
because that could send a credential to the wrong host. Provider switches do
not carry a previous provider's model, URL, or key name forward.

The decisions API is a typed contract, not a chat-completions endpoint. Exact
wire details and regression invariants live in [AGENTS.md](../../AGENTS.md) and
the public engine types.
