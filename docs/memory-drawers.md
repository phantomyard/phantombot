# Drawer entries: weight, supersession and decay

The five drawers — `people`, `decisions`, `lessons`, `commitments`, `norms` —
are rows in `drawer_entries` (`src/memory/drawers.ts`). This page is the
contract: what a row means, how an entry is retired, and **how a third-party
tool files or corrects a norm**.

**Since #417 the rows ARE the source of truth.** `memory/people.md` and the
other four no longer exist on a migrated persona: they were ingested, verified,
archived under `memory/archive/<date>/` and removed. Markdown is now an
*artefact* you can ask for — `phantombot memory drawers --export <dir>` renders
the table back out, and the round-trip is verified entry-for-entry before any
file is ever archived (`src/memory/drawerExport.ts`).

There is exactly one write path: the heartbeat FILES a `[tag]` line as a row,
and `phantombot memory drawers --kind <k> --file "<entry>"` is how anything
else files one. Nothing appends to a drawer file — if you find code that does,
it is a regression, not a fallback.

Because the drawers now live only in `memory.sqlite`, that database has
verified, rotating restore points: the nightly takes one per sweep, `doctor`
checks integrity and names the recovery command, and `phantombot memory
backup --list` / `memory restore --from <point>` are the operator surface. See
[Restore points](#restore-points).

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

## Restore points

`src/memory/dbBackup.ts`. One snapshot per nightly sweep, taken LAST, after the
distill, kb and compaction stages have settled — a restore point should
represent a finished night, not a database mid-rewrite.

- **Integrity is checked BEFORE the snapshot is taken.** A database that fails
  `PRAGMA integrity_check` is not snapshotted at all. Without that ordering the
  nightly would rotate corruption into all five restore points over five nights
  and delete the last good one.
- **`VACUUM INTO`, never `cp`.** A live WAL-mode database is three files;
  copying the main one mid-transaction yields a torn snapshot that
  `integrity_check` will happily call clean.
- **Restore moves the live file aside** to `<name>.pre-restore-<stamp>` and
  removes the `-wal`/`-shm` sidecars. A stale WAL replayed over a restored file
  turns a recovery into a corruption. Stop phantombot first; the CLI requires
  `--yes` and says so.
- **A missing database is not a fault.** It is created on first use, so a fresh
  box has none, and reporting that as broken teaches operators to ignore the
  line that matters.

```bash
phantombot memory backup            # take one now
phantombot memory backup --list     # points + each one's integrity verdict
phantombot memory restore --from /path/to/point.sqlite --yes
```

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

## Editing an export back in (`--with-id` / `--import`)

`--export` alone is a read-only artefact: a backup, or something to grep. Every
hand-edit to it used to be silently wrong — the parser has no way to tell
"this is the same entry, reworded" from "this is a brand-new entry", so an
edited line came back in as a duplicate on the next `--sync`, while the line it
was meant to replace sat there untouched, forever. Issue #437 closes that gap
with one marker instead of a general "trust whatever the file says" import.

```bash
phantombot memory drawers --export ./out --with-id   # tag every entry
# ... edit ./out/norms.md by hand ...
phantombot memory drawers --kind norms --import ./out
```

`--with-id` appends a trailing `<!-- id: kind:hexid -->` line to every
rendered entry, e.g.:

```markdown
- [norm] Friday deploys are routine.
<!-- id: norms:1a2b3c4d5e6f7890 -->
```

`--import` reads a marked (or plain) export back in and does exactly one of
three things per line, and nothing else — see `src/memory/drawerImport.ts`:

| line | what happens | why |
|---|---|---|
| unmarked | files as a new entry | same as `--file` / plain ingest; a line with no marker never claimed to replace anything |
| marked, **content unchanged** | reaffirms the row named by the marker | the content-derived id already equals the marker's id, so this is the ordinary re-file/reaffirm path with no special-casing |
| marked, **content changed** | supersedes whatever now stands in that marker's place | the edit *is* a correction: file the new content with `supersedes: <live id>`, same as a phantomtool correcting a norm |

**A marker names a lineage, not a snapshot.** An id is a hash of content, so
the moment you edit a marked line and import it, every copy of that export
still on disk names a row that has been retired — and an export is a file,
which people keep and edit again. So a *changed* line resolves its marker
**forward** through the supersession chain to whatever stands in that row's
place today, and supersedes that. Without the walk, a second edit of the same
file would re-retire the original and leave the intermediate row active beside
the new one: two active rows disagreeing, which is the duplicate `--import`
exists to prevent.

```bash
phantombot memory drawers --export ./out --with-id
sed -i 's/version a/version b/' out/norms.md && phantombot memory drawers --kind norms --import ./out
sed -i 's/version b/version c/' out/norms.md && phantombot memory drawers --kind norms --import ./out
# one active row: "version c" — even though both markers still say "version a"
```

Three consequences worth stating outright:

- The walk only runs for a **changed** line. An export lists a superseded row
  *and* its successor, each under its own marker, so walking unconditionally
  would compare the older line against the newer row and turn an unedited
  re-import into a supersession.
- Re-importing an **unedited** stale export changes nothing. Each line still
  matches the row its marker names, so it is a plain reaffirm.
- Importing the **same edited file twice** is a no-op. The walk lands on the
  row that content already produced, so it reaffirms rather than asking a row
  to supersede itself.

`--import -` (stdin) requires `--kind`, for the same reason `--file` does: the
directory form reads each drawer's kind off its filename and can loop over all
five, but stdin carries exactly one document, and without the guard it would be
drained into the first drawer in the list.

**Reaffirm is quiet; supersede is loud.** A supersession permanently retires a
row from a markdown edit, so every one is appended to *that day's* daily file
(`- [drawer-import] superseded <retired> -> <new>: "…" -> "…"`) — visible in
the ordinary next-turn digest the same day, with no separate review UI to build
or maintain. A stray keystroke that changes one character is now something you
see, not something that silently and permanently happened.

`<retired>` is the row that actually stopped being active, which is not always
the id written in the file. Because a marker names a lineage rather than a
snapshot (see below), the second edit of the same exported file names a row a
previous import already retired. The log records what was really taken out of
service, and keeps the file's id beside it as provenance when the two differ:

```
- [drawer-import] superseded norms:6bc32fa6 (marker named norms:5980f861) -> 1c656079: "…" -> "…"
```

Reading it the other way round — logging the marker's id — would claim a
supersession that never happened (a fork off one row into two successors) and
leave the row genuinely retired absent from the audit trail entirely. Since
that trail *is* the whole safety mechanism here, it has to name the real row.

**The marker is deliberately not "trust whatever the file says".** Two
guards, both structural rather than best-effort validation:

- **A marker only ever resolves within its own kind.** The marker embeds which
  drawer it came from (`norms:...`, `decisions:...`, …); `--import` compares
  that against the file it is importing and rejects the marker outright on a
  mismatch — a `norms.md` hand-edited to claim `decisions:...` cannot touch a
  decision. The line still files normally as a fresh entry; only the bogus
  supersession claim is dropped.
- **The id has to name a real row.** Ids are `sha256(persona, kind,
  normalized content)[..16]` — a hash, not a sequential counter — so there is
  nothing to guess or forge into colliding with a real row. A hand-typed or
  stale id that doesn't resolve here degrades to "no marker": the content
  still files as a new entry, nothing is superseded, nothing is destroyed.

Both failure modes are reported by `--import` (`rejected marker: …`) so a
tampered or stale marker is visible, not just silently dropped.

Applies uniformly to all five drawers — the marker only ever touches the
schema fields every kind already has (`asserted_at`, `last_reaffirmed_at`,
`supersedes`, `status`); only the decay *rate* differs per kind, not this
mechanism. `commitments` and `people` don't decay, but reaffirm/supersede work
exactly the same way on them.

No physical deletion, same rule as everywhere else in the drawer system — a
superseded row from an import stays queryable forever. Orphaned superseded
rows accumulating over repeated imports is a known, deliberately deferred
follow-up (#437), not something this mechanism solves.

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
memory/<date>.md --[tag] line--\
phantombot memory drawers --file-+--> drawer_entries --> judge briefing
phantomtools drawers.file() -----/     ^ source of truth   ^ ranked, decayed
                                       |
        memory drawers --export <dir> <-'   (markdown as an artefact)
```

- **Fill.** The heartbeat (`src/lib/heartbeat.ts`) files each `[tag]` line in
  today's daily journal as a row, dated from the journal's own date so a
  heartbeat that runs a day late does not park the entry on the wrong day.
  Re-filing is a reaffirmation enforced by a UNIQUE constraint, so a line is
  promoted once however many times the heartbeat sees it. With no database
  configured, nothing is written at all and the line waits for the next
  heartbeat — deliberately not a markdown fallback, because a second write path
  is what produced two disagreeing copies of the same entry before #417.
- **Migrate.** `src/memory/drawerSync.ts::syncDrawers()` also runs in the heartbeat
  (`src/lib/heartbeat.ts`), immediately *after* tagged lines are promoted into
  the markdown, so a line captured this cycle is a row by the end of the same
  cycle. It is skipped per drawer when the file's **content hash** is unchanged
  since the last sync — content, not mtime+size, because the compaction stage
  rewrites drawers wholesale and a same-length rewrite in the same millisecond
  is exactly when a skipped sync would strand the rows on stale text. The sync
  marker is written only after a successful ingest, so a crash re-runs that
  drawer rather than marking stale text done.
- **Retire.** Once a drawer's file content is provably in the table AND the
  table provably renders back out to the same entries, the heartbeat archives
  the file to `memory/archive/<date>/` — original bytes and regenerated export,
  side by side — and removes it (`src/memory/drawerRetire.ts`). A drawer that
  fails either gate keeps its file and is reported as `held`; the other four
  still retire.
- **Read.** `drawerSection()` returns ranked rows, and falls back to the raw
  markdown file **per drawer** when that drawer has no rows yet — which on a
  retired persona means "nothing", and on a mid-migration one means the file. A fresh
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
every startup while both representations exist.

Retirement is the separate step that follows it (`drawerRetire.ts`), and it is
gated on evidence rather than on a flag:

1. **Coverage** — every entry parsed out of the live file exists as a row,
   checked by an independent re-parse rather than by trusting the ingest's own
   counts. A parser bug that silently drops an entry shape fails here, before
   anything is removed.
2. **Recoverability** — the rows render back to markdown that re-parses to the
   same id set (`verifyDrawerRoundTrip`). A drawer that cannot be regenerated
   keeps its file.

Only then is the file copied to `memory/archive/<date>/` and unlinked. `rm` is
not a step; `copy, verify, unlink` is. Run it by hand with `phantombot memory
drawers --retire` — it exits non-zero if any drawer was held back, and prints
why.
