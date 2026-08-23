# Capability-routing Pi extension

Lets a strong-but-narrow **primary** Pi model delegate a vision subtask
**within a single turn** to an **image** model. This is *capability routing*,
which is orthogonal to phantombot's primary→fallback harness chain (that's
*failover* — try the next harness when one dies). The failover chain is
untouched by this extension.

## Why

No single cheap model is great at reasoning **and** vision. Pin a good
orchestrator as the primary and let it hand off a **vision question** to a
multimodal image model (`look_at_image`).

Coding is handled separately by phantombot's per-turn **coding-brain swap** (the
pi harness swaps the primary model for the configured coding model on a coding
turn), not by any tool this extension registers.

## Tools

| Tool | Registered when | What it does |
|------|-----------------|--------------|
| `look_at_image(path, question)` | `routing.json` has `imageModel` | Spawns the image model to answer a **specific question** about an image (question-driven, not a one-shot describe). Returns the answer + usage. |

### Always-on image delegate (the key behavior)

phantombot's `harness` wizard keeps an `imageModel` set whenever routing is
configured — an explicit pick, or (when the **primary** is itself vision-capable
and no pick is made) the **primary model** as the default. So this extension
registers `look_at_image` even for a multimodal primary. The tool's
**description** tells a model that can already see images NOT to call it — so a
vision primary won't, while a **text-only coding model swapped in for a code
turn** still has a vision delegate to reach for. `look_at_image` is omitted only
when the operator explicitly picks "(none)" for the image model.

## Config: `routing.json` (not env vars)

The extension reads a single managed data file, `routing.json`. phantombot bakes
it from the `[harnesses.pi.routing]` table of **the persona running this turn**.
Shape (every key optional):

```json
{
  "primaryModel": "deepseek-v4-pro",
  "imageModel": "gpt-4o"
}
```

| Key | Meaning |
|-----|---------|
| `primaryModel` | Orchestrator model id (bare name as printed by `pi --list-models`). Informational to the extension — phantombot's pi harness pins it via `--model`. |
| `imageModel` | Vision delegate. **Set whenever routing is configured** — an explicit pick, or the primary itself when the primary is vision-capable. Absent only when the operator picked "(none)" ⇒ `look_at_image` not registered. |

A blank/whitespace value is treated as absent. If `routing.json` is missing or
unparseable the extension registers **nothing** (the safe inert default).

### Which `routing.json` — `PHANTOMBOT_ROUTING_JSON`

One host runs many personas in one process, but the managed extension directory
is stamped **once per host**, so its sibling `routing.json` can only ever
describe one persona. `[harnesses]` is per-persona, so phantombot's pi harness
writes the routing of **this** persona into its own per-turn temp directory and
names that file in the `PHANTOMBOT_ROUTING_JSON` environment variable.

Resolution is therefore:

| `PHANTOMBOT_ROUTING_JSON` | What is read |
|---|---|
| set (non-blank) | **only** that file — it is authoritative. If it is missing, unreadable or invalid JSON the extension registers nothing rather than falling back, because the sibling belongs to a different persona. |
| unset or blank | the sibling `routing.json` next to `index.ts` — a bare `pi` run started by hand behaves exactly as it always has. |

This is the one env var the extension reads for config; the delegate models
themselves still travel as JSON, never as env vars.

> **Model env vars are no longer used by this extension.** The old
> `PHANTOMBOT_PRIMARY_MODEL` / `PHANTOMBOT_IMAGE_MODEL` / `PHANTOMBOT_CODING_MODEL`
> child-env projection has been removed; the wizard still writes those to `~/.env`
> / `config.toml` (suffixed per persona) as a *config* layer, but the extension
> reads models only from `routing.json` — `PHANTOMBOT_ROUTING_JSON` selects
> *which* file, it never carries a model.

## Install — automatic

You do **not** install this by hand. phantombot embeds the extension source in
its binary and **stamps it into `~/.pi/agent/extensions/capability-routing/` on
every startup**, overwriting that owned directory (the same way nginx owns
`conf.d` or systemd owns its drop-ins). `phantombot doctor` detects a missing or
drifted managed extension and re-stamps it. The `routing.json` is written
alongside the source from your current config — that stamped copy is the
default-persona/bare-`pi` fallback; a phantombot turn overrides it per persona
via `PHANTOMBOT_ROUTING_JSON` (above).

A manual symlink is only for **extension development** (so `/reload` picks up
edits to this repo without a rebuild):

```bash
ln -sfn "$(pwd)/pi-extension/capability-routing" ~/.pi/agent/extensions/capability-routing
```

After editing the extension source, regenerate the embedded assets so the binary
ships the change: `bun run gen:pi-extension`.

## Files

- `index.ts` — extension entry point; loads `routing.json` (per-persona override first, own dir otherwise) and registers `look_at_image` per the plan.
- `tools.ts` — pure registration-decision logic + delegation prompts (unit-tested from phantombot's `bun test`).
- `spawnPi.ts` — spawns a child `pi --mode json` process and captures structured output (messages, usage, cost, stop reason). Mirrors pi's own subagent example.
