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

### Always-on image delegate (the key behavior)

phantombot's `harness` wizard keeps an `imageModel` set whenever routing is
configured — an explicit pick, or (when the **primary** is itself vision-capable
and no pick is made) the **primary model** as the default. So this extension
registers `look_at_image` even for a multimodal primary. The tool's
**description** tells a model that can already see images NOT to call it — so a
vision primary won't, while a **text-only coding model swapped in for a code
turn** still has a vision delegate to reach for. `look_at_image` is omitted only
when the operator explicitly picks "(none)" for the image model.

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
  "codingModel": "gpt-5.2-codex",
  "codingProgress": true
}
```

| Key | Meaning |
|-----|---------|
| `primaryModel` | Orchestrator model id (bare name as printed by `pi --list-models`). Informational to the extension — phantombot's pi harness pins it via `--model`. |
| `imageModel` | Vision delegate. **Set whenever routing is configured** — an explicit pick, or the primary itself when the primary is vision-capable. Absent only when the operator picked "(none)" ⇒ `look_at_image` not registered. |
| `codingModel` | Coding delegate for `coder`. Absent ⇒ `coder` not registered. |
| `codingProgress` | Opt-in. When `true` **and** a `codingModel` is set, `coder` streams its progress to Telegram (see below). Omitted/`false` ⇒ silent coder. Baked only when both conditions hold. |

A blank/whitespace value is treated as absent. If `routing.json` is missing or
unparseable the extension registers **nothing** (the safe inert default).

### Coder progress streaming (opt-in)

A `coder` call is a **synchronous, blocking** tool call: the primary model is
parked until the coding child finishes, so a long job means a long silence. With
`codingProgress: true`, the extension forwards the coding child's **own per-turn
events** (Pi's `message_end` stream — assistant text + tool calls it makes) out
to Telegram via `phantombot notify` as the job runs, e.g. `coder: 🛠️ edit — adding
the retry guard`. No new tool contract, no async machinery — it just surfaces
what Pi already emits.

- **Throttled:** at most one notification per 15s; the first event always goes
  through so you see work has started.
- **Fire-and-forget:** each notification is a detached `phantombot notify`;
  errors are swallowed, so progress can never slow or break the coding job.
- **No double-report:** the final (terminal) turn is skipped — that text is the
  answer the parent model already receives as the tool result.

Off by default. Enable via the `phantombot harness` wizard ("Stream coder
progress to Telegram?") or set `coding_progress = true` under
`[harnesses.pi.routing]` in `config.toml` (env override:
`PHANTOMBOT_CODING_PROGRESS=true`).

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
