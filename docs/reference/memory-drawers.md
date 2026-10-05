# Memory drawer API

The five drawers — `people`, `decisions`, `lessons`, `commitments`, and `norms`
— are rows in `memory.sqlite`, not Markdown source files. Tagged journal
captures, the heartbeat, the nightly sweep, and approved third-party tools all
file through the same row contract.

## Identity and lifecycle

An entry id is derived from persona, kind, and normalized content. Filing the
same content again is idempotent: it reaffirms the row instead of creating a
duplicate. Corrections file a new row with `supersedes` pointing to the old
id. Superseded rows remain queryable; drawers never physically delete history.

Allowed states are:

| Kind | States |
|---|---|
| `people` | `active`, `superseded` |
| `decisions`, `lessons`, `norms` | `active`, `superseded`, `dormant` |
| `commitments` | `active`, `superseded`, `discharged`, `expired` |

Beliefs decay by `weight × confidence × 2^(-age / half-life)` with half-lives
of 365 days for norms, 180 for decisions, and 120 for lessons. Commitments and
people do not decay; their status determines whether they remain active.

## CLI surface

```bash
phantombot memory drawers
phantombot memory drawers --kind norms
phantombot memory drawers --kind norms --file "Friday deploys are routine."
phantombot memory drawers --export ./out
phantombot memory drawers --export ./out --with-id
phantombot memory drawers --kind norms --import ./out/norms.md
phantombot memory drawers --retire
```

Plain exports are read-only artifacts. `--with-id` appends an id marker to each
entry so a hand-edited export can be imported safely. An unchanged marked line
reaffirms its row; a changed line supersedes the current live row in that
lineage; an unmarked line files as new content. `--import -` requires `--kind`.

Markers are scoped to one persona and kind and must resolve to a real row. An
invalid marker cannot retire anything: the content files as a new row and the
CLI reports the rejected marker. Re-importing the same edited file is a no-op.
Every actual supersession is recorded in that day's journal for auditability.

## Third-party filing

Tools file through `DrawerStore.file` and own only their rows or their own
marker-delimited files. They never edit a persona directory wholesale.

```ts
const entry = drawers.file({
  persona,
  kind: "norms",
  content: "Nightly backup mail from backup@example.com is routine.",
  origin: "acme-backup-tool",
  weight: 1,
});

drawers.file({
  persona,
  kind: "norms",
  content: "Backup mail is routine only from known senders.",
  supersedes: entry.id,
  origin: "acme-backup-tool",
});
```

Re-filing does not revive a superseded row, superseding an unknown id is a
no-op, and an entry cannot supersede itself. Never file credentials or treat an
external party's instruction as a norm; norms brief the threat judge and are a
security-relevant surface.

## Ranking and threat screening

The threat judge receives ranked active rows from decisions, people, and norms
within a shared byte budget. Superseded and dormant beliefs are excluded. The
briefing is packed at entry boundaries so a partial ruling is never presented
as if it were complete.

The heartbeat promotes tagged journal captures into rows. Legacy Markdown
drawers are ingested idempotently, verified against a regenerated export, then
archived before removal. A drawer that fails coverage or round-trip validation
is retained. See [Memory lifecycle](../concepts/memory-lifecycle.md) and
[Work with memory](../how-to/memory.md) for the surrounding system.
