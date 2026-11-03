# Memory lifecycle

Phantombot memory has three jobs: keep the active conversation coherent,
capture facts worth carrying forward, and retrieve only the durable context
relevant to the next turn.

```mermaid
flowchart TD
    Turn[Conversation] --> Recent[(Recent turns)]
    Turn --> Capture[Tagged capture]
    Capture --> Journal[(Journal rows)]
    Journal --> Heartbeat[Mechanical heartbeat]
    Heartbeat --> Drawers[(Five drawers)]
    Journal --> Nightly[Nightly sweep]
    Nightly --> Long[MEMORY.md]
    Nightly --> KB[OKF knowledge base]
    Recent --> Index[(Search index)]
    Drawers --> Index
    Long --> Index
    KB --> Index
    Index --> Recall[Relevant context for a later turn]
```

## Recent conversation

Successful user and assistant turns are stored in SQLite and read back within
bounded history. When old turns leave the prompt window they remain searchable;
they are not the same thing as durable facts.

## Journal and captures

`phantombot memory capture` writes one journal row with zero or more tags. It
is indexed immediately. The tags are `decision`, `lesson`, `person`,
`commitment`, and `norm`.

Today's journal is injected because the day is still open. Yesterday is also
included when its nightly sweep did not finish. Selection is enforced in code,
not left to a persona prompt. The prompt uses bounded whole entries and keeps
the newest material.

## Five drawers

People, decisions, lessons, commitments, and norms are structured database
rows with ranking, decay, and supersession. The heartbeat promotes tagged
captures into them. They are not Markdown files and should not be hand-edited.
Norms and prior rulings also brief the threat judge.

Every capable turn gets a "Standing memory" block: the top-ranked active
entries of all five drawers, packed at entry boundaries under a 12 KB cap with
a per-drawer share (`src/memory/standingMemory.ts`, the same packer the judge
uses). It is a ranked selection, not the whole drawer. Every active entry is
also published to the search index as a virtual note at
`drawers/<kind>/<id>.md`, reconciled in one pass by the heartbeat, by every
`memory search` and by every CLI drawer write; `memory get` resolves those
paths back to the row. Commitments leave both when they are closed —
`discharged` (met) or `expired` (missed) — and the nightly's distil stage
closes the ones that are settled.

## Nightly distillation

After day rollover, the cognitive sweep processes closed journal days into the
drawers, a lean `MEMORY.md`, and linked Open Knowledge Format notes under `kb/`,
and closes settled commitments (paged, at most four pages of 50 a night).
It is checkpointed and idempotent: a healthy completed day is not repeatedly
reprocessed, while a changed or incomplete day is retried.

## Retrieval

The always-on index uses field-weighted lexical search plus wiki-link graph
expansion. Optional embeddings add a semantic result set; reciprocal-rank
fusion combines it with lexical results. Semantic indexing sends the plaintext
being embedded to the configured provider, so enabling it is a privacy choice.

See [Work with memory](../how-to/memory.md) for commands and backups.
