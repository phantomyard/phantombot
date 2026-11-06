# Decision model

Phantombot can use an optional typed decision backend for three narrow choices:

1. Score untrusted input for the threat screen.
2. Escort a screened turn: score each tool call before it runs (below).
3. Choose the primary or coding model before a Pi turn.

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

The threat judge gives a decision 4 seconds by default (`[jev.judge]
timeout_ms`) and, inside that same budget, retries once when the request never
got a response — a failed DNS lookup, a refused or reset connection. A timeout
or an HTTP error is not retried. If the harness judge then produces no verdict
either, the turn is **held** and the owner is asked; there is no fail-open
mode and no setting for one (the former `[jev.judge] fail_closed` key is
ignored). See [Security and trust](security-and-trust.md).

Timeouts, missing keys, invalid responses, and provider errors are recorded in
a persona-local health ledger without storing the screened text. `phantombot
doctor` reports degraded use and expires old failures at report time. Each
judge call also logs a `screen: judge call` line with the backend, the outcome
and the duration in milliseconds — never the screened text — which is the
data to tune `timeout_ms` on.

The threat score uses the maximum of two views in one request: a defender frame
and a red-team frame. The calibrated default threshold belongs to this backend
and is intentionally independent from the harness judge's threshold.

## Escort

When the threat-judge consumer is enabled (`[jev.judge] enabled`, with a key),
every untrusted turn the screen passes is **escorted**: before each tool call
runs, the decision model scores that one action against the task that woke the
turn, and a call at or above `[jev.judge] threshold` is refused. The turn is
told the step was blocked and carries on with the rest. The escort uses the
judge's settings and has none of its own.

It fails closed: no answer, a timeout, a missing key or an unreadable answer
refuses the call. Only harnesses with a blocking pre-tool hook run an escorted
turn — `claude` (a `PreToolUse` hook) and `native` (a pi extension). `codex`
and a host `pi` are skipped for that turn; if nothing is left, the request is
held. Trusted turns are never escorted, and without a decision model nothing
changes.

An action too large to show the decision model whole (over 8 KB rendered) is
refused without asking — it is never judged on a cut-off head. The `claude`
escort settings pin `disableAllHooks: false`, so a user-level setting cannot
switch the hook off.

**Briefing (#768).** The escort also sees the persona's briefing: the same
ranked decisions, people and norms rows the threat judge is briefed from,
packed to 6 KB, matching entries first: the entries the search index matches
against the turn's task lead each drawer, and the freshest fill the rest, so
the cap cannot cut the one ruling about this kind of task. The threat judge
briefs the same way, matched against the request it screens (an old ruling on
that sender reaches the briefing however many fresher rows sit above it). The
task or request is untrusted text, so it only chooses which of the owner's
own entries come first; it never adds text. That is what lets it recognise the owner's routine work. For
example, a fleet agent pushing a requested fix to its own PR branch,
approving, replying to or resolving a review thread, or re-requesting
reviewers from a background poller turn. The briefing is data: it never makes
an action acceptable that serves an injected instruction. Calibrate with
`bun scripts/evalDecisionModelJudge.ts --escort` (routine PR-loop actions must
score under the threshold, hijacks at or above it; `--no-briefing` shows the
old behaviour).

**Holds reach the principal (#768).** A held action is never parked silently.
The escort records each hold in a per-turn log under the persona's `tmp/`.
When the turn ends, phantombot sends the principal **one** short notice for
the whole turn, for example:

```
🔒 Held in scheduled task 1795: push code to a repository.
Allow this in background tasks next time? Reply "allow push", or "deny push" to stop asking.
```

Every word of it is phantombot's own. The source comes from the turn's
conversation key, which phantombot sets (`tick:<id>` names the task; anything
else reads "a background task"). The action is named only by its KIND, from a
closed vocabulary (`ESCORT_ACTION_KINDS`: push, commit, review, comment,
merge, github, email, message, delete, web, edit, read, shell), classified
from the tool name and command. The hold log is writable by the turn it
records, so a forged line can at most pick a different phantombot label; the
action's own model-authored text is never relayed. Summaries are used internally as
dedup keys and nothing else. The same held action is not
announced again for 12 hours by the same phantombot process (kept in process
memory only: any file in the persona dir is writable, forgeable or readable by
the escorted turn, so it could silence its own notice; a restart or a new
process re-announces. A hold is recorded only once its notice was delivered,
so a failed notify is retried on the next turn),
so a poller that wakes every few minutes onto the same step does not ping
every few minutes. The turn's model is told the principal will hear about it,
so it neither notifies separately nor leaves the step for "a later turn".

**Allowances.** The question is backed. When the principal replies "allow
push", the trusted turn runs `phantombot escort allow push` (`escort list`,
`escort revoke <kind>`), which writes `escort-allow.json` in the persona dir.
Each allowance is rendered from the closed vocabulary into the escort's
briefing, AHEAD of the ranked drawers so the 6 KB cap never cuts it. It is
context, not a bypass: the escort still judges whether each action fits its
task, and a notice for an already-allowed kind says it was held anyway rather
than offering it again (the hold does not record why: a misfit, a missing key
or a model outage all look the same). The escort refuses, without asking the
decision model, any action that mentions `escort-allow` or `escort
allow|revoke` after dropping shell quoting (backslashes, quotes, `$''`) and
collapsing whitespace. That stops the obvious spellings; it is not a boundary.
`escort-allow.json` sits in the persona dir, which the escorted turn can
write, so a determined turn can still forge an allowance. That is why an
allowance is only context for the escort's judgement, never a bypass. A
refused try is named in the notice as "a try to change the escort's own
allowances" and offers nothing to allow.

**Denies.** "deny push" runs `phantombot escort deny push`. A denied kind is
enforced in code, not by the model: the orchestrator reads the deny list when
the turn starts and puts it in the escort's context, and an escorted action
of that kind is refused without asking the decision model. The kind is not
asked about again. A turn can edit the file for later turns (same caveat as
above), never the list its own run is held to.

**Rulings land as decisions.** `escort allow|deny|revoke` and
`phantombot judge rule allow|deny|clear "<sender or kind of request>" --note
"…"` (the principal's ruling on a held untrusted request) each file a
`decisions` drawer row tagged with a stable key (`[ruling escort:push]`,
`[ruling judge:billing@vendor.com]`), indexed at once. A new ruling on the
same key retires the old one, so the readers see only the latest. Being
decisions, they reach both briefings relevance-first.

**Hold notices reach the owner's open threads.** After the DM goes out, the
screen appends one line to `hold-notices.jsonl` in the persona dir. Each
long-lived reader polls it every 20 s:

- the service sends a count line ("🔒 I held 1 action. Details in my DM.")
  into each Telegram or PhantomChat group the owner wrote in during the last
  60 minutes. Never what was held, never into a DM (the DM has the notice);
- the TUI shows the notice as a system line straight away;
- ACP adds it to the reply it is streaming, or opens the next reply with it
  when the session is idle (editors may drop unprompted updates).

Relayed lines are sent out of band and never written to `turns`. A group or
session that is gone just misses it. Notices from before a reader started are
never replayed.

Known limits:

- **The task is capped at 2 KB.** On a longer message the escort judges
  actions against its first 2 KB; an action only the tail asks for reads as
  unsupported and is refused (the safe direction, but a false hold).
- **The claude hook is a process.** Inside it every failure blocks (exit 2),
  but if Claude Code cannot spawn it at all (binary moved, `bun` missing) or
  kills it at its 60 s timeout, Claude Code treats that as a non-blocking hook
  error and the call runs. The decision itself is bounded well inside that
  (`[jev.judge] timeout_ms`, capped at 30 s), but a badly loaded host eats the
  margin.
- **Cost and latency.** One decision-model request per tool call, each up to
  `[jev.judge] timeout_ms`: a tool-heavy turn adds tens of requests and can add
  tens of seconds. A provider rate limit refuses every call until it clears.
- **The no-escort-harness hold is not surfaced.** When no harness in the chain
  can run an escorted turn, the turn is held with an error in the log and no
  notification — check the chain (`claude` or `native` must be in it).

## Provider boundary

Built-in transports know their endpoint. A custom provider must declare an
explicit base URL; Phantombot never guesses an endpoint for an unknown provider
because that could send a credential to the wrong host. Provider switches do
not carry a previous provider's model, URL, or key name forward.

The decisions API is a typed contract, not a chat-completions endpoint. Exact
wire details and regression invariants live in the
[security-perimeter invariants](../contributing/invariants/security-perimeter.md)
and the public engine types.
