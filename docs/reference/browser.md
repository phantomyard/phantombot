# Built-in web browser

Phantoms use `phantombot browser` by default to inspect rendered pages, read
text, click, type, scroll, and take screenshots. It uses experimental
`Bun.WebView` with an installed Chrome, Chromium, Edge, or Brave on the machine
running phantombot; it never bundles a browser or attaches to your personal
browser. On macOS it explicitly selects Chrome too. Set `BUN_CHROME_PATH` if
automatic discovery cannot find your executable. Running from source requires
a Bun version that provides `Bun.WebView` (verified with 1.4.2).
On macOS the dedicated automation profile uses a mock keychain to avoid native
keychain dialogs; its cookies rely on the private profile directory's permissions,
and it never accesses your personal browser profile or keychain.

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
Snapshots cap rendered text at 24,000 characters and interactive elements at
100; screenshot history is bounded to 32 PNGs in `browser/screenshots`.
The tool uses the installed browser's Chrome version and removes the headless
marker from its user agent before site navigation. Sites can still refuse access.
It does not disable Chrome's OS sandbox; restricted hosts need a browser that can
start under their local policy. Web content remains untrusted data.

