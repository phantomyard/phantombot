# Enable shell completion

`phantombot install` sets up dynamic completion for Bash, Zsh, and Fish. There
is no separate opt-in command. `phantombot update` refreshes the installed
stub, and `phantombot uninstall` removes it.

After installation, start a new shell or reload its configuration file.
Completion calls back into the binary on every Tab press, so suggestions match
the installed subcommands and flags. The hidden completion invocation is
read-only: it never opens the terminal UI or writes setup state.

If completion cannot find Phantombot, confirm the release directory is on the
shell's PATH. On Windows, restart the terminal after installation so it picks
up the updated user PATH.
