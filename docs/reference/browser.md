# Built-in web browser

Phantoms use `phantombot browser` by default to inspect rendered pages, read
text, click, type, scroll, and take screenshots. It uses experimental
`Bun.WebView` with an installed Chrome, Chromium, Edge, or Brave on the machine
running phantombot; it never bundles a browser or attaches to your personal
browser. Running from source requires a Bun version that provides
`Bun.WebView` (verified with 1.4.2).
On macOS the dedicated automation profile uses a mock keychain to avoid native
keychain dialogs; its cookies rely on the private profile directory's permissions,
and it never accesses your personal browser profile or keychain.

## Which browser it uses

When a persona's browser worker starts, phantombot decides which executable it
launches, in this order:

1. The persona's own choice, set with `phantombot browser use`.
2. `BUN_CHROME_PATH` from the host environment, used as-is.
3. The browser that started last time for this persona (cached in
   `<persona-dir>/browser/detected.json`).
4. Otherwise it test-launches each installed browser in turn and keeps the
   first one that actually starts: Chrome, Chromium, Brave, then Edge, with
   existing full Chromium builds in the user's Playwright cache next (newest
   revision first), and every Snap build (including Ubuntu's `chromium-browser`
   wrapper) last.
   Each test is a short headless launch (about a second) with the same flags
   and environment as the real worker, using a throwaway profile next to the
   real one. Snap confinement cannot open a profile under a hidden `$HOME`
   directory such as `~/.local/share`, so a Snap Chromium that runs fine from a
   terminal can still fail here; the test catches that.
5. If none of the known install or cache locations exist (Flatpak, NixOS, custom
   prefixes), Bun's own discovery is used.

The Playwright cache is `~/.cache/ms-playwright` on Linux (or
`$XDG_CACHE_HOME/ms-playwright` when the XDG root is absolute),
`~/Library/Caches/ms-playwright` on macOS, and `%LOCALAPPDATA%\ms-playwright`
on Windows. An absolute host `PLAYWRIGHT_BROWSERS_PATH` selects a custom cache
instead; relative values and `0` skip cache discovery. Both older Chromium and
newer Chrome for Testing layouts are recognized. Project-local installs and
headless-shell builds are excluded. Nothing is downloaded or installed.

If no installed browser starts, `open` fails with the list of what was tried. If
the cached browser later fails to start, the cache is dropped and the next open
detects again.

```bash
phantombot browser list            # installed browsers and the one in use (launches nothing)
phantombot browser use brave       # chrome | chromium | brave | edge
phantombot browser use /opt/custom/chrome
phantombot browser use auto        # forget the choice and detect again
```

`use` test-launches the choice before saving it (`<persona-dir>/browser/preference.json`)
and refuses one that is not installed or cannot start. It then stops the persona's
browser worker, so open tabs close; cookies and logins stay in the profile. A
chosen browser that is later moved is found again by the same name; it is never
silently swapped for a different browser. `list` and `use` need a trusted turn or
a terminal: a choice names a host executable, so sandboxed turns cannot change
it. They do use it, though: a sandboxed turn's temporary browser launches the
persona's chosen (or detected) browser.

## Commands

```bash
phantombot browser open https://example.com  # JSON: rendered text + CSS selectors
phantombot browser click 'a[href]'           # selector from the snapshot
phantombot browser read                     # current rendered snapshot
phantombot browser screenshot               # JSON: PNG path to inspect visually
phantombot browser type 'search terms'       # into the focused field
phantombot browser press Enter
phantombot browser scroll --dy 600
phantombot browser resize --width 1280 --height 800
phantombot browser close                    # current tab
phantombot browser stop                     # this persona's browser worker
```

With `open --user-agent "custom UA"`, set a tab's user agent before navigation.
Omitting the flag retains it on later opens and interactions. Use
`open --user-agent ""` to restore the installed Chrome identity. Broker requests
accept `userAgent: "custom UA"` or `userAgent: null` to reset. Overrides are
per tab, last until close/worker shutdown, and never change other tabs or profiles.
Values must be 1–512 printable ASCII characters with non-whitespace content.
Custom strings suppress UA client hints rather than advertising conflicting Chrome
metadata; reset restores Chrome's original UA and client hints. This does not
emulate another browser's engine, OS, or full fingerprint.

After `click` or `press`, if the page starts a navigation within 300 ms the
reply waits (up to 8 seconds) for that page to finish loading, so the snapshot is the
new page rather than the old one. `screenshot` reads the URL and title from the
live page. A failed action such as a missing selector leaves the tab open, with
its page and login (the error says "the tab is still open"); only a tab that no
longer responds is closed. If Chrome's own click check gives up because the element
never stops moving (animated headers, throttled headless frames), phantombot
clicks its center once, but only if the element is visible there and not covered
by another element.

Use `--session NAME` for another tab, and `--persona NAME` for another persona.
Tabs otherwise follow the current conversation (or `default` in a terminal).
Cookies and logins live in `<persona-dir>/browser/profile`, shared by that
persona's tabs. Sandboxed turns forward these commands through the existing
authenticated runtime broker. Their Chrome process runs on the host with a
fresh profile under `<persona-dir>/browser-turns/`, outside model-writable scratch,
and is stopped and deleted when that turn ends. The sandbox's filesystem and
process restrictions stay unchanged; no personal cookies are inherited.
Without a live runtime broker, a sandboxed browser command refuses explicitly.

For visual inspection inside a bounded turn, use the broker operation directly:

```json
{"operation":{"kind":"browser","request":{"action":"screenshot"}}}
```

It returns an actual image content block to native and MCP harnesses. The CLI
also returns a PNG artifact path in that turn's scratch. Screenshot artifacts
are created exclusively at the scratch root, never through a model-writable
subdirectory or symlink. The broker exposes only the same bounded browser
actions; models cannot choose host paths, executable flags, profiles, or CDP calls.
Page downloads are denied before site navigation, so pages cannot save arbitrary
files into the owner's Downloads folder. This tool returns text and screenshots.

Before creating a turn profile, abandoned `turn-*` directories older than one
hour are removed; a live owner PID preserves even long-running turns.

Each profile has its own lazy worker process, authenticated loopback endpoint,
eight-tab limit, 30-second operation deadline and five-minute idle shutdown.
A worker whose Chrome has died exits after reporting the error. Bun cannot
relaunch Chrome in the same process, so the next command starts a fresh worker.
Snapshots cap rendered text at 24,000 characters and interactive elements at
100; screenshot history is bounded to 32 PNGs in `browser/screenshots`.
The tool uses the installed browser's Chrome version and removes the headless
marker from its user agent before site navigation. Sites can still refuse access.
It does not disable Chrome's OS sandbox; restricted hosts need a browser that can
start under their local policy. Web content remains untrusted data.

