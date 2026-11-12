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

Every agent wake is read by the threat judge before the model sees it, the
same as any other request that did not come from you directly in chat. If the
judge holds a wake, that fire does nothing, you get the usual held-request
notification, and `phantombot task log` shows the run as `held`. See
[Security and trust](../concepts/security-and-trust.md).

## What a task wake can and cannot do

An agent wake (a task without `--command`) is an untrusted turn, so once the
judge passes it, it runs in the sandbox like any other untrusted turn. It has
network and the persona vault in its environment, so git, gh, curl and API work
behaves as usual. It can write only to its per-turn scratch dir
(`$PHANTOMBOT_SCRATCH`), which is deleted when the turn ends. It cannot see SSH
private keys, the persona folder, or any other host path, and it cannot write
anywhere under `$HOME`. Notify and memory capture/search still work through the
broker. See [Bounded security](../reference/bounded-security.md).

A `--command` task is not sandboxed. `phantombot tick` runs the command as an
ordinary process of the host user, in the persona folder, with the minimal
environment plus any `--secret`s. Only a `phantombot ask` the script issues
becomes an untrusted (screened, sandboxed) turn.

| Needs to... | Use |
|---|---|
| Read the web or APIs, reason, notify, capture memory | agent task |
| Write files under `$HOME`, use `ssh`, run host scripts | `--command` task |
| Both | `--command` wrapper: the script calls `phantombot ask`, takes the reply text from stdout, and does the host-side writes or ssh itself |

```bash
#!/bin/sh
# daily-report.sh - the model writes the text, the script writes the file
set -e
out="$HOME/notes/reports/$(date +%F).md"
phantombot ask "Summarise yesterday's releases as markdown" > "$out.tmp"
mv "$out.tmp" "$out"
```

```bash
phantombot task add "Daily release report" "Daily report" \
  --every 1d --command "$HOME/bin/daily-report.sh"
```

Tasks created before the sandbox became the default (#785, v1.1.492) keep their
schedule. An agent task that writes outside scratch or uses ssh now fails at its
next fire; move that work into a `--command` script as above.

Tasks run silently by default. Use `phantombot notify` only when the owner
asked to be interrupted or something material happened. Run `phantombot task
selftest` to verify the scheduler end to end.
