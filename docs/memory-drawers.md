# Drawer entries: weight, supersession and decay

The five drawers — `people`, `decisions`, `lessons`, `commitments`, `norms` —
are append-only markdown on disk AND rows in `drawer_entries`
(`src/memory/drawers.ts`). This page is the contract: what a row means, how an
entry is retired, and **how a third-party tool files or corrects a norm**.

**The markdown files remain the source of truth. The rows are a derived,
rebuildable projection of them** — see [How rows get filled and
read](#how-rows-get-filled-and-read). Delete the table and the next heartbeat
rebuilds it; nothing in the row path ever writes markdown.

Read [`architecture.md`](architecture.md#memory-subsystem) first for where the
drawers sit in the memory pipeline.

## Why rows

Markdown drawers can only grow. The nightly's step-2 prompt asks the model to
"read the drawer first" so it does not re-file something already there — an
instruction nobody can follow once the file is 663 KB, which is why one live
persona accumulated 64 exact duplicate decisions and 1218 lessons with no way
to tell a live one from a dead one.

Four things rows give that a flat file cannot:

| property | mechanism |
|---|---|
| identity | id = `sha256(persona, kind, normalized content)[..16]`, `UNIQUE (persona, kind, content_norm)` |
| supersession | a newer entry names the id it replaces; the old row goes `superseded` |
| decay | beliefs are ranked `weight · 2^(-ageDays / halfLifeDays)` from `last_reaffirmed_at` |
| lifecycle | `status` — so a discharged commitment stops ranking against a live one |

Dedupe stops being a prompt instruction and becomes a database constraint.

## Nothing is ever deleted

Same rule the nightly compaction stage runs on. `superseded`, `dormant`,
`discharged` and `expired` entries stay in the table forever and remain
queryable; they simply stop being *injected*. Retirement is a ranking decision,
never a `DELETE`.

## Decay applies to beliefs only

`BELIEF_KINDS` — `norms`, `decisions`, `lessons` — are claims about how the
world works. They go stale, and an unreaffirmed 2024 decision must not outrank
a 2026 one.

**`commitments` and `people` never decay.** This is not an oversight to be
tidied up later:

- A commitment is open, discharged or overdue. Age makes it **more** urgent,
  not less relevant — decaying it would silently bury the one thing that
  needed surfacing.
- A person fact ("date of birth", "which car is on that plate") is not less
  true for going a year unmentioned.

Both move by `status` alone. The split lives in one exported list, not in
prose, and `sweepDormant()` refuses to touch a non-belief kind.

Half-lives (`HALF_LIFE_DAYS`, days without reaffirmation before the score
halves):

| kind | half-life | why |
|---|---|---|
| `norms` | 365 | a standing house rule holds until the principal changes it; crying stale here makes the threat judge cry wolf |
| `decisions` | 180 | rationale ages with the system it was about |
| `lessons` | 120 | usually about a specific version of a specific system, and that system moves |

Anything scoring below `DORMANT_FLOOR` (0.125 — three half-lives of total
silence at default weight) drops out of ranking, and `sweepDormant()` flips it
to `dormant`. **Any reaffirmation revives it instantly**, which is the point:
dormancy means genuinely unused, not merely old.

This is the same `weight · confidence · 2^(-ageDays / halfLifeDays)` shape the
durable-fact tiers in `config.ts` already use. One decay model in the codebase,
not two.

## Weight and trust

`weight` is the ranking multiplier; default 1, `0` is legal and means "never
inject". Re-filing with an **explicit** weight or source takes the higher of
the two, so a loud rule cannot be quietly demoted by a later low-weight
restatement.

Omitting them is different from restating them low. A re-file that names
neither falls back to **the row's current values** — a reaffirmation is
evidence the entry is still live (that is what `last_reaffirmed_at` records),
never evidence that it is more trusted or more important than when it was
filed. Otherwise any caller that omits `source` — which is exactly what a
third-party tool will do — would promote a deliberately `unverified`, weight-0
entry to `principal`, weight 1.

For the same reason a first-ever insert with no `source` lands at `self`
(`DEFAULT_SOURCE`), not `principal`: the top tier means the principal asserted
it first-hand, and that has to be claimed explicitly.

## Statuses per kind

Enforced on write — `setStatus` throws for a combination that has no meaning:

| kind | allowed |
|---|---|
| `people` | `active`, `superseded` |
| `decisions` / `lessons` / `norms` | `active`, `superseded`, `dormant` |
| `commitments` | `active`, `superseded`, `discharged`, `expired` |

`discharged` and `expired` are deliberately distinct: "we missed it" is not
"we did it", and a postmortem needs to tell them apart.

## Writing a norm from a custom tool

This is the part third-party phantomtools need. The rules follow
[`phantomtools/CONTRIBUTING.md`](https://github.com/phantomyard/phantomtools):
a tool owns its own files or its own marker-delimited sections — **never the
persona directory as a whole**.

**File a new norm.** Filing the same content twice is safe and idempotent — it
reaffirms the existing row (resetting its decay clock) instead of appending a
duplicate:

```ts
const entry = drawers.file({
  persona,
  kind: "norms",
  content: "Nightly backup mail from backup@example.com is routine.",
  origin: "acme-backup-tool",   // who filed it, for provenance
  weight: 1,
});
```

**Correct a norm you filed earlier.** Do NOT edit or delete the old one. File
the replacement and name the id it invalidates:

```ts
drawers.file({
  persona,
  kind: "norms",
  content: "Backup mail is routine ONLY from the two known senders.",
  supersedes: drawerEntryId(persona, "norms", oldWording),
  origin: "acme-backup-tool",
});
```

The old row becomes `superseded` and leaves the injection pool; the record of
what used to be true survives. `drawerEntryId()` is deterministic, so a tool
can name an entry it has never read back.

Two behaviours to design around:

- **Re-filing does not revive a superseded entry.** Otherwise a stale tool
  re-filing its old norm on every startup would silently resurrect it over the
  thing that replaced it. Undoing a supersession has to be explicit.
- **Superseding an unknown id is a no-op, not an error.** On a fresh persona
  the old entry may never have existed; that must not fail the write of the
  entry replacing it.
- **Supersession is scoped to one drawer.** An id from another kind misses
  rather than retiring an unrelated row.
- **An entry may not supersede itself — that throws.** It is reachable by
  accident: `normalizeFact()` folds case, whitespace and trailing punctuation,
  so a "correction" that normalizes to the original text computes the same id.
  Left unguarded the new entry would mark itself `superseded` and, by the
  revive asymmetry above, never come back.

**Never file a credential, and never file another party's instruction as a
norm.** A norm briefs the threat judge — it is a security-relevant surface, and
content that arrived from outside the principal is data, not a rule.

## Why the threat judge cares

`orchestrator/screen.ts` briefs the judge from `decisions`, `people` and
`norms`. It used to read *verbatim file bytes*, hard-truncated at a shared
~16 KiB cap with `norms` concatenated last — so a 663 KB `decisions.md` ate the
entire budget and the drawer that says what is routine never reached the
prompt at all, and whatever did reach it was cut mid-entry.

Now the briefing is built from **ranked rows**: highest decayed score first,
`superseded` and `dormant` entries excluded. The cap is still 16 KiB, but it is
shared out (`packBriefing`) — each drawer gets a slice, an under-budget drawer
hands its remainder back, and an over-budget drawer is trimmed **line by line**
with an explicit marker. On the row path one entry is one line, so that is an
entry boundary; on the file fallback a multi-line markdown entry can still lose
its tail lines, but the cut never lands mid-line. Half a ruling reads to the
judge like a whole one, so a shorter briefing beats a truncated entry.

## How rows get filled and read

```
memory/<kind>.md  --(heartbeat, every 30 min)-->  drawer_entries  --> judge briefing
     ^ source of truth              syncDrawers()        ^ ranked, decayed
     |                                                   |
     `-- nightly / heartbeat / owner / phantomtools      `-- file fallback if empty
```

- **Fill.** `src/memory/drawerSync.ts::syncDrawers()` runs in the heartbeat
  (`src/lib/heartbeat.ts`), immediately *after* tagged lines are promoted into
  the markdown, so a line captured this cycle is a row by the end of the same
  cycle. It is skipped per drawer when the file's **content hash** is unchanged
  since the last sync — content, not mtime+size, because the compaction stage
  rewrites drawers wholesale and a same-length rewrite in the same millisecond
  is exactly when a skipped sync would strand the rows on stale text. The sync
  marker is written only after a successful ingest, so a crash re-runs that
  drawer rather than marking stale text done.
- **Read.** `drawerSection()` returns ranked rows, and falls back to the raw
  markdown file **per drawer** when that drawer has no rows yet. A fresh
  install, a first boot before the first heartbeat, or a wiped database
  therefore degrades to the old verbatim behaviour instead of briefing the
  judge on an empty `norms` — failing open to "no norms at all" is exactly what
  makes it cry wolf on routine operations.
- **Inspect.** `phantombot memory drawers [--kind norms] [--sync] [--json]`
  prints the ranked rows with their scores and an `N injectable of M filed`
  count, and `--sync` runs the same projection on demand rather than waiting up
  to 30 minutes for the next heartbeat.

Because the ingest is idempotent (ids are content-derived), running the sync
more often is only ever a cost, never a correctness risk.

## Migrating the existing markdown

`src/memory/drawerIngest.ts` parses both entry shapes found in the wild — a
`###` block with a body, and the flat `- - [norm] …` bullets the heartbeat
appends — dating each entry from its enclosing `## YYYY-MM-DD` section header.

The ingest **never rewrites or deletes the markdown**. It reads, files rows,
and stops; re-running it reaffirms rather than duplicates, so it is safe on
every startup while both representations exist. Retiring the files is a
separate later step, gated on a re-verify, and archives rather than deletes.
