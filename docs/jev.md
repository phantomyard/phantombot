# Jev — the optional TypeSafe System One screener

[TypeSafe Jev](https://openrouter.ai/typesafe/jev-1.13) is not an LLM. It is a
"System One" model: unstructured text in, a **typed choice with a calibrated
probability** out — no free-text generation at all. Phantombot can use it as a
dedicated backend for the two places that want exactly that shape:

1. **The threat judge** — screening untrusted input before a capable turn runs.
2. **The brain-swap router** — the `primary | coder` choice in front of every
   Pi turn (`src/lib/coderSwap.ts`).

Jev is **optional** and **never a harness**. It cannot generate strings, write
code, or hold a conversation, so it can never serve a user turn; it only ever
*decides*. A user with no Jev-capable token sees **no behaviour change
whatsoever**: with no `[jev]` block and no `PHANTOMBOT_JEV_*` env var,
`config.jev` is `undefined` and both call sites take their existing paths.

## Why

The default threat judge is a full tool-less LLM turn on the harness chain.
That has three costs:

- **It fails open.** When every harness in the chain is exhausted, the screen
  logs `judge unavailable, failing open` and the untrusted turn runs
  unscreened. Jev is a different vendor, credential and quota pool to
  claude/codex/pi — a fleet-wide harness quota outage no longer takes the
  security control down with it.
- **It is slow and it costs a turn.** Every untrusted message pays a full
  frontier-model round trip (seconds) to answer what is essentially a small
  classification question. Jev answers in ~70–500 ms at ~$0.042/Mtok input
  (output free) — about $0.00004 per decision.
- **It requires a harness at all.** A security control should not inherit the
  availability of the thing it is guarding.

The router has the mirror-image problem: the keyword scorer is free and
instant but blind in both directions — a pasted stack trace with "why is this
failing?" scores 0, while a passing mention of "merge" in chat can hard-trigger
the coding brain onto a conversational turn.

## Model facts (verified against the OpenRouter API, 2026-09-20)

| | |
|---|---|
| id | `typesafe/jev-1.13` (endpoint `typesafe/jev-1.13-20260917`) |
| modality | `text -> decisions` |
| context | 32,000 tokens (max completion 28,800) |
| price | $0.042 / Mtok input, output free |
| latency | vendor claims 70–500 ms end to end |
| choices | cardinality capped at 255, schema match guaranteed |
| tool_choice | none / auto / required / function |

The decision is requested as a single function tool with `tool_choice`
forced, over an OpenAI-compatible chat-completions endpoint (OpenRouter, or
TypeSafe direct). See `src/lib/jev.ts`.

## Configuration

`phantombot jev` (or the **Jev** row on the persona settings screen, `^s`)
walks you through it. Provider choice comes **first**:

- **OpenRouter** — if any OpenRouter credential already exists in the vault
  (e.g. the embeddings `PHANTOMBOT_OPENAI_COMPATIBLE_API_KEY` when its
  endpoint is OpenRouter, or a stored `PHANTOMBOT_JEV_API_KEY`), the wizard
  offers **"Use existing key" as the default with no token prompt at all**
  and stores nothing new — `[jev]` just points `key_env` at the existing
  name. A token is only asked for when there is nothing to reuse.
- **Direct (TypeSafe)** — a native TypeSafe token and the API base URL
  (confirm it against your TypeSafe dashboard; the prefill is a starting
  point, not a verified constant).

The key is validated with one live forced-tool call before anything is
stored, and credentials live in the **vault**, never `config.toml`. Judge and
router are enabled **independently** — wanting the cheap router without
moving your security control is a normal choice.

The resulting block:

```toml
[jev]
provider = "openrouter"            # or "typesafe"
model = "typesafe/jev-1.13"
base_url = "https://openrouter.ai/api/v1"
key_env = "PHANTOMBOT_JEV_API_KEY" # the vault/env NAME the key is read from

[jev.judge]
enabled = true
mode = "shadow"                    # or "active"
timeout_ms = 1500                  # hard cap; exceeding it = fallback
threshold = 80                     # hold at/above this score (default: THREAT_THRESHOLD)
fail_closed = false                # see "Both backends down" below

[jev.router]
enabled = true
mode = "shadow"                    # or "active"
timeout_ms = 300                   # in front of EVERY turn — must never stall one
```

Every field has an env override (`PHANTOMBOT_JEV_PROVIDER`, `_MODEL`,
`_BASE_URL`, `_KEY_ENV`, `_JUDGE`, `_JUDGE_MODE`, `_ROUTER`, `_ROUTER_MODE`),
env beats TOML as everywhere in phantombot. An `api_key` written into the
TOML block is **ignored with a warning** — secrets never live in the
plaintext file. Timeouts, threshold and fail_closed are TOML-only and survive
wizard re-runs (merge semantics: the wizard never resets tuning it doesn't
ask about).

`/status` reports the Jev line (provider, per-consumer state, live key
validation), and the settings screen badges from it.

## Shadow mode, then active

Both consumers ship in **shadow mode** and that is the recommended first
state:

- **Shadow**: the existing method decides (the harness judge / the keyword
  scorer). Jev answers **alongside** — concurrently, so it costs max(), not
  sum() — and only the comparison is logged. Agreements are `info`;
  divergences are `warn` with both scores/routes and both reasons. Those log
  lines are the promotion evidence.
- **Active**: Jev decides. Any error, timeout, or missing key degrades to the
  existing method with no user-visible difference beyond a log line.

The acceptance bars are deliberately **separate**: the judge is a security
control (a wrong answer is an unscreened prompt — measure the false-negative
rate on injection), the router is routing quality (a wrong answer is a worse
reply). They do not share a threshold or a rollout gate.

Two rules keep active mode safe:

- **The manual override always wins.** `/coder` / `/nocoder` are the
  operator's explicit word; Jev is never even consulted when one is set.
- **Hard latency caps.** The router's default budget is 300 ms; exceeding it
  falls back to the keyword score, never stalls a turn.

## Briefing parity (the load-bearing requirement)

The learned-decisions machinery — the decisions/people/norms drawers, ranked
and decayed, captured only from trusted turns — lives in the **briefing
assembly**, not in the model. Swapping the judge's brain to Jev changes who
reads the brief, not how it is built or how rulings are recorded.

So the Jev judge receives the **same ranked drawer briefing** as the harness
judge: the same `readBriefingDrawers` rows, the same equal-share packing that
guarantees norms their budget (a runaway decisions drawer can never starve
them), the same `<briefing>`/`<untrusted_content>` wrapping with the same
forgery strip. Two deliberate differences, both forced by Jev's 32k-token
context, both exactly what shadow mode exists to measure:

1. The harness judge runs as the **full narrowed persona** (identity +
   MEMORY + drawers). Jev cannot carry that, so it gets the module
   `JUDGE_SYSTEM` classifier prompt — the same text the harness path falls
   back to when the persona can't load — plus the drawers through the
   `<briefing>` channel.
2. The caps are tighter: drawers at 12 KB (`JEV_JUDGE_BRIEFING_CAP_BYTES`)
   and the untrusted payload at 48 KB (`JEV_JUDGE_CONTENT_CAP_BYTES`).

**Drop order** when the budget bites: the payload's tail is cut first (marked
`[payload truncated at cap]`), then drawer entries are dropped lowest-rank
first within each drawer's equal share. Norms — the drawer that stops the
judge crying wolf — are never starved.

The typed verdict is `{score 0-100, verdict ∈ {allow, hold}, reason,
question}`. The screener consumes the **score** so threshold semantics are
identical to the harness judge's; a verdict/score disagreement (hold with a
low score, allow with a high one) is logged as a calibration signal, never
silently resolved.

## Both backends down: the fail-closed question

Today a total judge outage fails **open** — the alternative was "app down",
and chasing fail-closed on infrastructure hiccups enshittifies the assistant.
A cheap, independent screener changes the arithmetic: with Jev active, a
both-down turn means *two* vendors' infrastructure failed at once, which is
rare enough that holding becomes affordable.

So `[jev.judge] fail_closed = true` is available, default **false**
(today's semantics, unchanged). When set and both Jev and the harness judge
error, the turn is **held** and the principal is notified that screening is
down — the same hold path as a real escalation. This only exists when Jev is
active; without an independent screener the harness chain failing open is
still the right default.

## Evaluation

Two authored corpora (synthetic but representative; multilingual; **no real
user data**) ship in `tests/fixtures/`:

- `jev-judge-corpus.json` — injections (EN/ES/NL, forged-briefing,
  calm-and-routine exfiltration, indirect web injection), benign traffic, and
  weighted-ruling nuance cases ("invoices from X are fine, bank-detail
  changes always come back to me") that specifically exercise briefing
  parity.
- `jev-router-corpus.json` — the keyword scorer's known misses in both
  directions, plus follow-up and topic-change cases.

Run them with a real key:

```bash
PHANTOMBOT_JEV_API_KEY=sk-or-... bun scripts/evalJevJudge.ts           # judge
PHANTOMBOT_JEV_API_KEY=sk-or-... bun scripts/evalJevJudge.ts --router  # router
```

The judge report leads with the **false-negative rate on injection** and
exits 1 on any miss (`--allow-false-negatives` downgrades to a report). A
screener that is fast and cheap but misses prompt injection is worse than the
harness judge it would replace — that number is the promotion gate, alongside
the shadow-mode divergence logs from real traffic.

## Where things live

| | |
|---|---|
| Shared client | `src/lib/jev.ts` |
| Judge adapter | `src/lib/jevJudge.ts` |
| Router adapter | `src/lib/jevRouter.ts` |
| Judge call site | `src/orchestrator/screen.ts` |
| Router call site | `src/harnesses/pi.ts` (threaded via `src/harnesses/buildChain.ts`) |
| Config | `[jev]` in `src/config.ts` |
| CLI wizard + write path | `src/cli/jev.ts` (`applyJevConfig`) |
| TUI flow | `src/tui/jevFlow.ts` (Jev row on `^s`) |
| Eval | `scripts/evalJevJudge.ts`, `tests/fixtures/jev-*.json` |
