# Schedule work

Scheduled tasks live in SQLite, survive restarts, and keep a run history. Every
task has two positional arguments: the prompt to run and a short description.

```bash
# Run once, then delete the task
phantombot task add "Remind me to call Sam" "Call Sam" --in 30m

# Run repeatedly for a bounded period
phantombot task add "Check the release pipeline" "Release check" --every 1h --for 8h

# Inspect and cancel
phantombot task list
phantombot task log "$TASK_ID"
phantombot task cancel "$TASK_ID"
```

Use exactly one scheduling mode: `--in` or `--at` for one-off work, and
`--every` for recurring work. Recurring tasks can be bounded with `--until`,
`--count`, or `--for`. An unbounded recurring task continues until cancelled.

For cheap deterministic polling, use `--command`. The command runs without
waking a model and receives a minimal environment. Expose only explicitly
needed vault variables with repeated `--secret NAME` options. The command can
call `phantombot ask` when it detects agent work.

Tasks run silently by default. Use `phantombot notify` only when the owner
asked to be interrupted or something material happened. Run `phantombot task
selftest` to verify the scheduler end to end.
