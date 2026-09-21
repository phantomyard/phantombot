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
  classification question. Jev answers in ~300 ms measured (vendor claims
  70–500 ms) at ~$0.042/Mtok input (output free) — about $0.00002 per
  two-question judge call, measured 2026-09-20.
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
| latency | vendor claims 70–500 ms; measured p50 ~300 ms (2026-09-20) |
| choices | criteria cardinality capped at 255 |
| score levels | ordinal scale capped at 10 levels per score question |
| endpoint | `/api/alpha/decisions` — **not** chat/completions |

The decision is requested over the **decisions API**, not chat/completions —
Jev is a decisions-only model and rejects chat/completions with HTTP 400
("is a decisions model … Use the /api/alpha/decisions endpoint instead").
The request is `{model, instructions, state, questions}`: `instructions` is
the classifier frame, `state` the payload the decision is about, and
`questions` a record of typed questions — `{type: "choice", instructions,
criteria: {<choice>: <description>}}` (the criteria KEYS are the choice set)
or `{type: "score", instructions, criteria: [<level label>, …]}` (criteria
index IS the ordinal level). The response is `{answers: {<qid>: …}, usage}`
with calibrated `probabilities` and `confidence` per answer. See
`src/lib/jev.ts`.

## Configuration

`phantombot decision-model` (deprecated alias: `phantombot jev`; or the
**Decision model** row on the persona settings screen, `^s`) walks you
through it. Provider choice comes **first**:

- **OpenRouter** — if any OpenRouter credential already exists in the vault
  (e.g. the embeddings `PHANTOMBOT_OPENAI_COMPATIBLE_API_KEY` when its
  endpoint is OpenRouter, or a stored `PHANTOMBOT_JEV_API_KEY`), the wizard
  offers **"Use existing key" as the default with no token prompt at all**
  and stores nothing new — `[jev]` just points `key_env` at the existing
  name. A token is only asked for when there is nothing to reuse.
- **Direct (TypeSafe)** — a native TypeSafe token and the API base URL
  (confirm it against your TypeSafe dashboard; the prefill is a starting
  point, not a verified constant).

The key is validated with one live decisions call before anything is
stored, and credentials live in the **vault**, never `config.toml`.
Reusable-key discovery is **persona-scoped** — on a multi-persona daemon the
ambient environment belongs to whichever vault was injected at startup, so
the wizard reads the TARGET persona's vault (via `getPersonaSecret`) rather
than offering the default persona's key. Judge and router are enabled
**independently** — wanting the cheap router without moving your security
control is a normal choice.

The resulting block:

```toml
[jev]
provider = "openrouter"            # or "typesafe"
model = "typesafe/jev-1.13"
base_url = "https://openrouter.ai/api/v1"
key_env = "PHANTOMBOT_JEV_API_KEY" # the vault/env NAME the key is read from

[jev.judge]
enabled = true                     # an enabled consumer DECIDES
timeout_ms = 1500                  # hard cap; exceeding it = fallback
threshold = 70                     # hold at/above (calibrated — see "Evaluation")
fail_closed = false                # see "Both backends down" below

[jev.router]
enabled = true                     # an enabled consumer DECIDES
timeout_ms = 800                   # in front of EVERY turn — must never stall one
```

`threshold` must be 0..100 and both timeouts 1..30000 — out-of-range values
are **rejected at config load**, because threshold 101 would silently
disable every hold and a non-positive timeout can throw inside
`AbortSignal.timeout`.

Every field has an env override (`PHANTOMBOT_JEV_PROVIDER`, `_MODEL`,
`_BASE_URL`, `_KEY_ENV`, `_JUDGE`, `_ROUTER`),
env beats TOML as everywhere in phantombot. An `api_key` written into the
TOML block is **ignored with a warning** — secrets never live in the
plaintext file. Timeouts, threshold and fail_closed are TOML-only and survive
wizard re-runs (merge semantics: the wizard never resets tuning it doesn't
ask about).

`/status` reports the decision-model line (provider, per-consumer state,
live key validation), and the settings screen badges from it.

## On or off — there is no third state

An enabled consumer **decides**, and the built-in method is the fallback on
any error, timeout or missing key: the harness judge for the screener, the
keyword scorer for the router. There is no user-visible difference beyond a
log line and a counter.

A log-only "shadow" mode (Jev answering alongside, divergences logged, never
deciding) shipped in the first draft of #597 and was **removed before
merge**. It doubled every call site for evidence that is better produced two
other ways: offline, by the bundled eval corpora below, which measure the
number that actually matters (false negatives on injection) against a known
answer key rather than against the harness judge's opinion; and at runtime,
by the fallback telemetry `phantombot doctor` reports. An operator who has
configured a decision model wants it deciding.

The acceptance bars are deliberately **separate**: the judge is a security
control (a wrong answer is an unscreened prompt — measure the false-negative
rate on injection), the router is routing quality (a wrong answer is a worse
reply). They do not share a threshold or a rollout gate.

Two rules keep a deciding backend safe:

- **The manual override always wins.** `/coder` / `/nocoder` are the
  operator's explicit word; Jev is never even consulted when one is set.
- **Hard latency caps.** The router's default budget is 800 ms — sized from
  the live corpus, where realistic states (a pasted trace, a PR description)
  run 300–600 ms and a 300 ms cap timed out 8/10 cases, i.e. made the
  backend a permanent fallback. Exceeding the budget falls back to the
  keyword score, never stalls a turn.

## Fallback telemetry — why `doctor` has a decision-model line

Falling back is silent by design: the turn is still screened, still routed,
still answered. That is the right runtime behaviour and the wrong
operational one — an operator who configured a decision model believes it is
deciding, and a revoked key or a provider outage would otherwise show up
only as behaviour quietly reverting to the built-in method. That is exactly
the shape of #516, where a revoked embeddings key dropped memory search to
keyword-only and doctor reported "semantic search off" with no reason.

So every call records its **outcome** — never the screened payload — in a
per-persona ledger (`<persona-dir>/.jev-health.json`, `src/lib/jevHealth.ts`):
calls, fallbacks, last success, last fallback, the last provider error
(capped at 300 chars) and the consecutive-fallback streak. Counters are
scoped to a rolling 24 h window (a total with no timeframe is unreadable);
the last-seen facts outlive the window, because they answer "is it broken
right now".

`phantombot doctor` prints it:

```
  decision model: DEGRADED — openrouter 'typesafe/jev-1.13' · judge fell back
    4/9 call(s) to the harness judge — last error: 401 Unauthorized
  → falling back to the harness judge / keyword scorer on those calls
    (last 24h). Check the key with `phantombot decision-model` and the
    provider's status; screening and routing still work meanwhile
```

It is **informational, never an exit-code input** — the same neutrality as
the embeddings line. A fallback is a designed degradation, not a fault, and
a security control that pages someone because its optional accelerator is
down is a worse security control. Writes are best-effort and atomic: the
ledger can never fail the turn it is observing, and two concurrent turns may
lose one increment to a read-modify-write race, which is accepted — it is a
health indicator, not an accounting ledger.

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
context:

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

The verdict is **two typed questions in one decisions call** — Jev emits no
prose, so the harness judge's free-text reason/question fields have no Jev
equivalent:

- `score` — an ordinal 0–9 scale whose levels are the 0–100 deciles,
  labelled to match `JUDGE_SYSTEM`'s bands (the vendor caps a score question
  at 10 levels, which is why the scale is deciles); asked **twice** — the
  defender frame and a red-team frame — and the consumed score is the **max**
  of the two mapped back to 0–100 (the one-call ensemble: the live eval's
  false negatives were all calm-tone attacks a single frame under-scored).
- `verdict` — a choice over `{allow, hold}`, Jev's native typed decision.
  The choice question is **anchored** with the same semantics the score
  bands carry: unanchored, Jev answers "hold" for any external content at
  all, which makes the cross-check useless.

The screener consumes the **score**; a verdict/score disagreement (hold with
a low score) is logged at **debug** as a calibration signal, never silently
resolved in either direction. Debug, not warn, on purpose: a cautious choice
frame makes disagreements routine on benign traffic (observed live on Atlas),
and a warn operators learn to ignore is worse than none. The same applies to
the frame-split line (defender vs red-team ≥ 30 apart). The reason/question strings the
held-request surface expects are **synthesised** from the typed answers (the
matched decile band, the choice, the confidence) — grounded in what Jev
returned, never fabricated prose.

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
  calm-and-routine exfiltration, indirect web injection), benign traffic,
  weighted-ruling nuance cases ("invoices from X are fine, bank-detail
  changes always come back to me") that specifically exercise briefing
  parity, and the conversational personal-data-ask class ("what's on my
  calendar today?", EN/ES/NL) — added after Atlas's live test scored one
  such ask at 53/100, 17 points under threshold.
- `jev-router-corpus.json` — the keyword scorer's known misses in both
  directions, plus follow-up and topic-change cases.

Run them with a real key:

```bash
PHANTOMBOT_JEV_API_KEY=sk-or-... bun scripts/evalJevJudge.ts           # judge
PHANTOMBOT_JEV_API_KEY=sk-or-... bun scripts/evalJevJudge.ts --router  # router
```

The judge report leads with the **false-negative rate on injection** and
exits 1 on any miss (`--allow-false-negatives` downgrades to a report).
**Errors are a failing gate in their own right**, judge and router both: a
run whose requests all errored evaluated nothing, and must never print "0
false negatives" and exit 0. A screener that is fast and cheap but misses
prompt injection is worse than the harness judge it would replace — that
number is the acceptance gate.

**Calibration evidence (2026-09-20, against the live endpoint):** at the
harness judge's raw threshold of 80, Jev under-scored subtle attacks
(calm-tone and non-English injections at 56–78) — System One reserves the
top deciles for the blatant. The shipped default is therefore
`JEV_JUDGE_DEFAULT_THRESHOLD = 70`. Observed live on the bundled corpus:
every injection scores ≥ 70; benign cases score ≤ 24 on the original corpus
and up to 33 on the conversational personal-data-ask class added after
Atlas's live finding — call the observed benign ceiling **33**, a 37-point
false-positive margin (these are observed values from stochastic live runs,
not deterministic guarantees). At that threshold the corpus runs **27/27:
0/10 false negatives, 0 false positives, ~374 ms avg**; the router corpus
runs **10/10 with 0 disagreements**. Re-running these corpora is the
evidence loop for moving either number.

## Where things live

| | |
|---|---|
| Shared client | `src/lib/jev.ts` |
| Judge adapter | `src/lib/jevJudge.ts` |
| Router adapter | `src/lib/jevRouter.ts` |
| Judge call site | `src/orchestrator/screen.ts` |
| Router call site | `src/harnesses/pi.ts` (threaded via `src/harnesses/buildChain.ts`) |
| Config | `[jev]` in `src/config.ts` |
| CLI wizard + write path | `src/cli/decision-model.ts` (canonical; `phantombot jev` is a deprecated alias) + `src/cli/jev.ts` (`applyJevConfig`) |
| TUI flow | `src/tui/jevFlow.ts` (Decision model row on `^s`) |
| Eval | `scripts/evalJevJudge.ts`, `tests/fixtures/jev-*.json` |
