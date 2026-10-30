# TUI keys

Keys in the chat screen of the interactive TUI (`phantombot` in a terminal).
The prompt box follows Emacs/readline conventions; the Home/End keys and
PgUp/PgDn belong to the transcript.

## Editing the prompt

| Key | Action |
| --- | --- |
| `←` / `→`, `Ctrl-B` / `Ctrl-F` | One character back / forward. |
| `Alt-B` / `Alt-F`, `Alt-←` / `Alt-→` | To the start of the previous word / the end of the next word, across lines. |
| `Ctrl-A` / `Ctrl-E` | Start / end of the current line. Pressed again: start / end of the whole input. |
| `↑` / `↓`, `Ctrl-P` / `Ctrl-N` | One row up / down, as drawn (wrapped rows count). On the first / last row they scroll the transcript instead. |
| `Backspace` | Delete the character before the cursor. |
| `Ctrl-D` | Delete the character under the cursor. |
| `Alt-Backspace` / `Alt-D` | Delete back to where `Alt-B` lands / forward to where `Alt-F` lands. |
| `Ctrl-W` | Delete back to the previous space, so a path or URL goes in one press. |
| `Ctrl-U` | Delete back to the start of the line. Pressed again at the line start: everything before the cursor. |
| `Enter` | Send. |
| `Shift-Enter`, `Ctrl-Enter`, `Alt-Enter` | New line, in terminals that report modifiers (kitty protocol, CSI-u). |
| `Ctrl-J` | New line, in every terminal. |
| `Tab` | Complete a half-typed slash command. |

A word is a run of letters, digits and combining marks. Whitespace,
punctuation, newlines and emoji separate words.

Deleted text is gone: there is no kill ring, so `Ctrl-Y` does nothing.
`Ctrl-K` opens the key inspector rather than deleting to the end of the line.
The `Delete` key acts as `Backspace`, because Ink reports both keys the
same way; use `Ctrl-D` to delete forward.

The cursor is drawn as the character under it in inverse video, or as a solid
cell at the end of a line. Moving it never re-wraps the text.

## Transcript and app

| Key | Action |
| --- | --- |
| Scroll wheel / trackpad | Scroll the transcript, the same as `↑` / `↓`. |
| `PgUp` / `PgDn` | Scroll the transcript one page. |
| `Shift-↑` / `Shift-↓` | Scroll the transcript one line. |
| `Home` / `End` | Jump to the top / the live end of the transcript. |
| `Ctrl-C` | Stop the running turn (the same as `/stop`). It never quits. |
| `Ctrl-Q` | Quit, the same as typing `/quit` (or `/q`, `/exit`). The phantombot service keeps running. |
| `Ctrl-S` | Open settings. |
| `Ctrl-K` | Toggle the key inspector: the raw bytes the terminal sent. |

While the transcript is scrolled away from the live end, `↑` / `↓` keep
scrolling it until it is back at the bottom.

The app never captures the mouse, so click-drag selection and copy stay the
terminal's own. The wheel works because most terminals turn it into `↑` / `↓`
on the alternate screen. macOS Terminal.app only does that while the
application has switched the cursor keys to application mode, as `less` and
`vim` do, so the TUI switches that mode on while it runs and off again on exit.

## Alt on macOS: Option as Meta

The `Alt` bindings need the terminal to send Alt as an Esc prefix. Most Linux
and Windows terminals do this by default. On macOS, Option types characters
instead (`Option-B` is `∫`, `Option-F` is `ƒ`) until you change it:

- **iTerm2:** Settings → Profiles → Keys → General → *Left Option key*:
  `Esc+`. Set it on the profile the window actually uses (Session → Edit
  Session…); the right Option key has its own setting.
- **Terminal.app:** Settings → Profiles → Keyboard → *Use Option as Meta key*.

`Ctrl-K` shows what arrives: with Option set up as Meta, `Option-B` shows as
`\u001bb`; without it, as `∫`.
