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
