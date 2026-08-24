# How phantombot finds a harness binary

Every "harness NOT FOUND" report comes down to two questions: which *path* did
phantombot decide to use, and which *resolver* looked for it. This page
documents both, because they are separate layers and they used to disagree.

## The path: precedence chain

`loadConfig` picks each harness's `bin` from the first source that yields a
value:

| # | Source | Example |
|---|--------|---------|
| 1 | Env var | `PHANTOMBOT_CLAUDE_BIN=/opt/claude/bin/claude` |
| 2 | `config.toml` | `[harnesses.claude] bin = "claude.cmd"` |
| 3 | **`state.json` → `harness_bins.<id>`** | written automatically on a successful resolve |
| 4 | Bare-name default | `"claude"`, `"pi"`, `"codex"` |

Layer 3 is the one that surprises people. `state.json` lives in the **data
dir**, not next to `config.toml`, so it is not cleared by editing — or even
deleting — your config file. It is a cache of "where we found this last time",
and it wins over the default.

That caching is deliberate (it keeps the daemon fast and stable across
restarts), but it means a path resolved under one runtime can be read back
under another. The classic case is Windows: run phantombot once under WSL or
Git Bash, `state.json` records `/bin/claude`, and a later native-Windows run
reads that value back. Because `path.win32.isAbsolute("/bin/claude")` is
`true`, the path looks well-formed to the Windows resolver — it just never
resolves. It presents to the user as a bad hardcoded default.

**Persisted paths are now filtered by platform shape** (`isUsablePersistedBin`).
A POSIX-rooted path on Windows, or a `C:\` / UNC path on POSIX, is discarded so
the chain falls through to the bare-name default, which the search sweep below
can then find. This is a string test on path *flavour* only: a well-formed path
that merely doesn't exist right now is **kept**, because reporting a missing
install against the configured path is the honest diagnostic.

### Clearing a stale entry by hand

```bash
phantombot doctor                      # shows the resolved path per harness
```

Then edit `harness_bins` out of `state.json` in your data dir
(`%APPDATA%\phantombot\state.json` on Windows, `~/.local/share/phantombot/state.json`
on Linux, `~/Library/Application Support/phantombot/state.json` on macOS), or
override it outright:

```toml
# config.toml — layer 2 beats the persisted layer 3
[harnesses.claude]
bin = "claude"
```

## The resolver: one detector, three fallbacks

`resolveHarnessAvailability()` is the **single** entry point. For a given bin it
tries, in order:

1. **Absolute path** — resolved directly, with `PATHEXT` suffixes applied on
   Windows (`claude`, `claude.cmd`, `claude.exe`, …).
2. **`PATH` lookup** for a bare name.
3. **Search-path sweep** (`harnessSearchPath()`) over the places harness CLIs
   actually install but which are often absent from a service `PATH`:
   `%APPDATA%\npm`, `~/.bun/bin`, `~/.local/bin`, and nvm/fnm node version
   directories.
4. **Absolute → bare-name retry** — if a configured *absolute* path misses, the
   bare default (`claude`) is tried through steps 2–3. This is what rescues a
   stale absolute path without the operator having to find it first.

Every caller goes through this: `doctor`, `run`, the `phantombot harness`
wizard, and `init`. That is the point — the wizard must never be a weaker
detector than the daemon it is configuring. Previously the wizard called a bare
`whichBinary()` on the configured bin, skipping steps 3 and 4, so `doctor` could
resolve claude while `harness` reported NOT FOUND on the same box.

## Debugging checklist

```bash
phantombot doctor                      # resolved path + source per harness
phantombot harness                     # wizard's view — must now agree with doctor
echo $PATH                             # is the install dir even visible?
```

If `doctor` and `harness` ever disagree again, that is a bug in the shared
resolver, not in your config — file it.
