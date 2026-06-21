# Capability-routing Pi extension

Lets a strong-but-narrow **primary** Pi model delegate specialist subtasks
**within a single turn** to an **image** model and a **coding** model. This is
*capability routing*, which is orthogonal to phantombot's primary→fallback
harness chain (that's *failover* — try the next harness when one dies). The
failover chain is untouched by this extension.

## Why

No single cheap model is great at reasoning **and** vision **and** coding. Pin a
good orchestrator as the primary and let it hand off:

- a **vision question** to a multimodal image model (`look_at_image`), and
- a **PR/MR-scoped coding job or review** to a coding model (`coder`).

## Tools

| Tool | Registered when | What it does |
|------|-----------------|--------------|
| `look_at_image(path, question)` | `PHANTOMBOT_IMAGE_MODEL` is set | Spawns the image model to answer a **specific question** about an image (question-driven, not a one-shot describe). Returns the answer + usage. |
| `coder(task, cwd?)` | `PHANTOMBOT_CODING_MODEL` is set | Spawns the coding model as a **fresh `pi` process** with `edit,bash,write` for a coarse-grained job. Returns the result + usage/cost. |

### Multimodal auto-skip (the key behavior)

When the chosen **primary** model already accepts image input, phantombot's
`harness` wizard leaves `PHANTOMBOT_IMAGE_MODEL` **unset**. This extension then
does **not** register `look_at_image` — the primary can see images itself, so a
separate vision delegate would be dead weight. You only ever see
`look_at_image` when the primary is text-only.

### Coarse-grained coder caveat

`coder` spawns a **fresh `pi` process per call**. Process startup is expensive,
so each delegation should be a big self-contained chunk (a whole PR/MR-scoped
change or a full review), **not** a chatty back-and-forth. Usage/cost from the
child is surfaced back to the parent in the tool result.

## Env-var contract

phantombot writes these (via `phantombot harness`) and exports them to the child
`pi` process. The extension reads only these env vars at load — no knowledge of
phantombot's config files required.

| Env var | Meaning |
|---------|---------|
| `PHANTOMBOT_PRIMARY_MODEL` | Orchestrator model id (bare name as printed by `pi --list-models`). Informational to the extension. |
| `PHANTOMBOT_IMAGE_MODEL` | Vision delegate. **Set only when the primary is not multimodal.** Unset ⇒ `look_at_image` not registered. |
| `PHANTOMBOT_CODING_MODEL` | Coding delegate for `coder`. Unset ⇒ `coder` not registered. |

Empty string is treated as unset. The same values are mirrored to
`config.toml` under `[harnesses.pi.routing]` (`primary_model`, `image_model`,
`coding_model`) so the choice survives a fresh shell and is visible to
`phantombot doctor`; env wins over TOML, matching every other phantombot
setting.

## Install

Symlink this directory into Pi's user extensions dir (survives `pi update`,
hot-reloads with `/reload`):

```bash
ln -sfn "$(pwd)/pi-extension/capability-routing" ~/.pi/agent/extensions/capability-routing
# optional: the coder agent template
mkdir -p ~/.pi/agent/agents
ln -sf "$(pwd)/pi-extension/capability-routing/agents/coder.md" ~/.pi/agent/agents/coder.md
```

## Files

- `index.ts` — extension entry point; registers `look_at_image` / `coder` per the plan.
- `tools.ts` — pure registration-decision logic + delegation prompts (unit-tested from phantombot's `bun test`).
- `spawnPi.ts` — spawns a child `pi --mode json` process and captures structured output (messages, usage, cost, stop reason). Mirrors pi's own subagent example.
- `agents/coder.md` — coder agent template (model pinned at runtime from `PHANTOMBOT_CODING_MODEL`).
