# Security and trust

Phantombot derives authority from the request's authenticated origin, not from
the wording inside the request.

## Trusted requests

An allow-listed owner on a configured chat channel, the local terminal UI, and
local ACP editor sessions are trusted entry points. They can direct normal
persona work because the speaker already controls the account or authenticated
channel identity.

## Untrusted requests

Email, webhooks, bridges, raw programmatic `ask` calls, and future ambient
inputs are untrusted. Before a capable harness receives conversation history or
retrieved knowledge, a capability-restricted threat judge scores the request.
A suspicious request is held and surfaced to the owner; it does not execute.

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
- **Interactive work gets an "Are you sure?" prompt, and only that.** When the
  owner is on the line and asks for something that cannot be undone and would
  seriously damage their world or the phantom itself — deleting data with no
  backup, rewriting git history, destroying a machine or volume, moving money,
  wiping the phantom's identity, vault or memory — the persona says what will
  be lost and asks once. It is a second chance before an accident, not a
  permission system: reversible work is never held for it.

If the judge cannot be reached at all, the request proceeds unscreened; the
turn runs on the same model chain, so a real outage stops both. If the judge
answers but no score can be read from the answer, the next model in the
persona's chain is asked instead, without bothering the owner. Only when every
model has been asked and none produced a score is the request held — as an
ordinary failed screening, with the same notification as any other hold. An
answer with no score in it is what a successful manipulation of the judge
looks like, so it is never waved through.

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
