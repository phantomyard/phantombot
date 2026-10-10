# Security and trust

Phantombot derives authority from the request's authenticated origin, not from
the wording inside the request.

## Trusted requests

An allow-listed owner on a configured chat channel, the local terminal UI, and
local ACP editor sessions are trusted entry points. They can direct normal
persona work because the speaker already controls the account or authenticated
channel identity.

## Untrusted requests

Email, webhooks, bridges, raw programmatic `ask` calls, scheduled task wakes,
and future ambient inputs are untrusted. Before a capable harness receives
conversation history or retrieved knowledge, a capability-restricted threat
judge scores the request. A suspicious request is held and surfaced to the
owner; it does not execute.

A scheduled task is judged on every fire, including one the owner asked for:
nobody is typing at the moment it runs, the prompt has sat in a table since it
was written, and a poller can schedule a wake whose prompt is the text of an
inbound email. A held fire does nothing, is recorded as `held` in
`phantombot task log`, and still counts as that fire, so the owner is asked
once rather than every minute. The only wakes that skip the judge are system
tasks, whose prompt the runtime wrote itself (today the scheduler selftest).
The nightly memory cycle is a system job as well; it runs on its own timer and
is not a task at all.

The judge receives only the context needed to decide risk, including ranked
prior rulings from the decisions, people, and norms drawers. It has no tools.
Only a later trusted owner conversation can approve the held request or record
a durable ruling.

The judge asks one question: is someone outside trying to take control of the
assistant, or trick it into something its owner would disapprove of? Impact
alone is not a threat — routine work from a known source scores low even when
it is privileged.

## One gate per channel

Each side of the perimeter has exactly one check.

- **Autonomous work is gated by the judge, and only the judge.** A request the
  judge passes is carried through end to end, including the steps that change
  things. There is no second "ask the owner first" step afterwards: the owner
  is not on the line to answer it, and an approval they have to repeat forever
  is not a control. The persona still treats everything it reads as data, never
  as instructions, and reports content that tries to steer it.
- **Interactive work has no security gate.** When the owner is on the line
  their instructions are genuine and are acted on. The persona still outlines
  a plan and asks before a long job or one it cannot easily undo, which the
  owner can waive for the rest of the conversation — that is a planning
  habit, not a permission system.

A request is only carried out when a judge has scored it. If the judge answers
but no score can be read from the answer, the next model in the persona's
chain is asked instead, without bothering the owner. When every model has been
asked and none produced a score, the request is held — as an ordinary failed
screening, with the same notification as any other hold. An answer with no
score in it is what a successful manipulation of the judge looks like, so it
is never waved through.

If no judge can be reached at all — the decision model and every model in the
chain are down, or the connection is — the request is held as well, and the
owner is told that it could not be screened (not that it looked dangerous).
There is no setting that turns this into a pass. The alternative would let a
flaky connection do an attacker's work: the judge and the turn can use
different providers, and a lookup that fails for the judge may succeed for the
turn a few seconds later, so "unreachable" cannot be read as "nothing will run
anyway". The cost is that a persona on a bad connection holds scheduled tasks
and inbound mail it would otherwise have run, and asks.

Limit worth knowing: the judge reads the message that starts a turn. Content
the persona fetches while working — a web page, an API response, another
email — is not screened; it is covered only by the data-not-instructions
discipline.

## Boundaries

- Quoted messages, retrieved memory, documents, tool output, and catch-up text
  are data. They do not become commands by appearing inside a trusted turn.
- Slash commands (`/update`, `/restart`, `/reset`, `/harness`, …) are answered
  only for an authenticated owner, on every channel. From a sender who is
  answered but is not an owner — a Telegram bot or PhantomChat persona with no
  allowlist, a PhantomChat bridge — a line starting with `/` is ordinary
  screened input, not a command.
- Secrets are encrypted per persona and loaded only into that persona's harness
  environment.
- Harness failover preserves the same trust decision; it does not broaden the
  tool surface or leak persona-scoped credentials into global state.
- Model-provider privacy and retention terms still apply to prompts sent to the
  selected provider.

Threat screening reduces prompt-injection risk; it does not make autonomous
tools infallible. Keep destructive and public actions behind explicit owner
authority and verify the result on the real runtime.
