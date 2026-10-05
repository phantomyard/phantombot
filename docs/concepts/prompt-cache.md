# Prompt-cache epochs

Prompt caching is an optional optimization for self-hosted or local inference.
It preserves Phantombot's ownership of conversation history, retrieval, trust,
and durable memory while reusing an exact prompt prefix where the backend can
benefit.

```toml
[prompt_cache]
enabled = false
max_epoch_bytes = 80000
```

Hosted-provider users should normally leave it disabled: hosted APIs manage
their own caching, and a client-side epoch can increase billed input without
controlling provider reuse.

An epoch begins from canonical history and appends completed
context/user/assistant triples. It rebases when the byte budget is reached or
when history is reconstructed. Epoch state is disposable and is never a source
of durable truth.

## Security boundaries

The cache key follows semantic context, not a long-lived transport conversation
ID. The epoch is discarded or rebased when:

- trust changes between trusted and untrusted input;
- a request is held by the threat screen;
- the active persona changes, including an A → B → A transition;
- the effective screening or tool surface changes;
- state is missing, corrupt, or inconsistent.

The runtime still supplies the complete correct prompt when a backend cannot
reuse the prefix. Cache preparation, completion bookkeeping, or discard errors
fall back to the ordinary path and never turn a successful model response into
a failed user turn. Cache telemetry contains metadata only, never prompt text.
