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
| `look_at_image(path, question)` | `routing.json` has `imageModel` | Spawns the image model to answer a **specific question** about an image (question-driven, not a one-shot describe). Returns the answer + usage. |
| `coder(task, cwd?)` | `routing.json` has `codingModel` | Spawns the coding model as a **fresh `pi` process** with `edit,bash,write` for a coarse-grained job. Returns the result + usage/cost. |

### Multimodal auto-skip (the key behavior)

When the chosen **primary** model already accepts image input, phantombot's
`harness` wizard omits `imageModel` from the baked `routing.json`. This
extension then does **not** register `look_at_image` — the primary can see
images itself, so a separate vision delegate would be dead weight. You only ever
see `look_at_image` when the primary is text-only.

### Coarse-grained coder caveat

`coder` spawns a **fresh `pi` process per call**. Process startup is expensive,
so each delegation should be a big self-contained chunk (a whole PR/MR-scoped
change or a full review), **not** a chatty back-and-forth. Usage/cost from the
child is surfaced back to the parent in the tool result.

## Config: `routing.json` (not env vars)

The extension reads a single managed data file, `routing.json`, that lives
**next to this directory's `index.ts`**. phantombot bakes it from `config.toml`'s
`[harnesses.pi.routing]` table. Shape (every key optional):

```json
{
  "primaryModel": "deepseek-v4-pro",
  "imageModel": "gpt-4o",
  "codingModel": "gpt-5.2-codex"
}
```

| Key | Meaning |
|-----|---------|
| `primaryModel` | Orchestrator model id (bare name as printed by `pi --list-models`). Informational to the extension — phantombot's pi harness pins it via `--model`. |
| `imageModel` | Vision delegate. **Present only when the primary is not multimodal.** Absent ⇒ `look_at_image` not registered. |
| `codingModel` | Coding delegate for `coder`. Absent ⇒ `coder` not registered. |

A blank/whitespace value is treated as absent. If `routing.json` is missing or
unparseable the extension registers **nothing** (the safe inert default).

> **Env vars are no longer used by this extension.** The old
> `PHANTOMBOT_PRIMARY_MODEL` / `PHANTOMBOT_IMAGE_MODEL` / `PHANTOMBOT_CODING_MODEL`
> child-env projection has been removed; the wizard still writes those to `~/.env`
> / `config.toml` as a *config* layer, but the extension reads only `routing.json`.

## Install — automatic

You do **not** install this by hand. phantombot embeds the extension source in
its binary and **stamps it into `~/.pi/agent/extensions/capability-routing/` on
every startup**, overwriting that owned directory (the same way nginx owns
`conf.d` or systemd owns its drop-ins). `phantombot doctor` detects a missing or
drifted managed extension and re-stamps it. The `routing.json` is written
alongside the source from your current config.

A manual symlink is only for **extension development** (so `/reload` picks up
edits to this repo without a rebuild):

```bash
ln -sfn "$(pwd)/pi-extension/capability-routing" ~/.pi/agent/extensions/capability-routing
```

After editing the extension source, regenerate the embedded assets so the binary
ships the change: `bun run gen:pi-extension`.

## Files

- `index.ts` — extension entry point; loads `routing.json` from its own dir and registers `look_at_image` / `coder` per the plan.
- `tools.ts` — pure registration-decision logic + delegation prompts (unit-tested from phantombot's `bun test`).
- `spawnPi.ts` — spawns a child `pi --mode json` process and captures structured output (messages, usage, cost, stop reason). Mirrors pi's own subagent example.
- `agents/coder.md` — coder agent template (model pinned at runtime from the coding model).
