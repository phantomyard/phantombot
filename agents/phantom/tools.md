# Tools available to Phantom

This file is descriptive markdown that Phantom (the model running inside the harness) reads as part of its system prompt. It is **not** a tool-call schema — phantombot does not orchestrate tool calls.

Use it to point the model at concrete things it should know how to use:

## Examples

- **Shell.** You have a Bash tool. Working directory is the agent dir. Use it for file operations, git, etc.
- **SSH targets.**
  - `kw-omv` (`192.168.86.82`) — shared Obsidian vault host. Vault path: `/srv/dev-disk-by-uuid-.../Shared/MyDocuments/Obsidian/obsidian-hodges`.
  - (etc — list real hosts here)
- **Scripts.** `~/clawd/scripts/foo.sh` does X. Prefer it over re-implementing.
- **Web access.** Use your built-in fetch/web-search tools for real-time info.
- **Memory.** Phantombot stores conversation turns in SQLite. You don't need to do anything special — earlier turns of this conversation are already in your context.

Replace the placeholder content with your real tool inventory before deploying.
