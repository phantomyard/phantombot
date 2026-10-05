# Work with memory

Memory is persona-scoped. Search before re-deriving a fact, and capture durable
decisions and lessons as they happen.

```bash
phantombot memory search "deployment rollback"
phantombot memory capture "Production uses blue-green deploys" --tag decision
phantombot memory drawers --kind decisions
phantombot memory journal --date 2026-10-04
phantombot memory index
phantombot memory backup
```

Capture tags are `decision`, `lesson`, `person`, `commitment`, and `norm`. One
capture may carry several tags. Captures are written as journal rows and become
searchable immediately; the mechanical heartbeat promotes tagged items to the
five structured drawers, and the nightly sweep distils closed days into the
drawers, `MEMORY.md`, and the knowledge base.

Use `phantombot memory list` and `phantombot memory get` for persona-relative
files. The five drawers and current journal are database rows, not hand-edited
Markdown files. `memory journal` reads a complete day; rendered daily files are
compatibility and recovery artefacts.

Backups are restore points for the memory database. List and restore them only
through the installed command surface:

```bash
phantombot memory backup --list
phantombot memory restore --from /path/to/point.sqlite --yes
```

Stop Phantombot before restoring. The command moves the live database aside,
removes stale WAL sidecars, verifies the selected restore point, and requires
`--yes` because it replaces the active memory database.

Run `phantombot doctor` when indexing, nightly processing, or capture health
looks wrong. See [Memory lifecycle](../concepts/memory-lifecycle.md) for the
storage and retrieval model.
