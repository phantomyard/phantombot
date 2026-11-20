# Built-in web browser

Phantoms use `phantombot browser` by default to inspect rendered pages, read
text, click, type, scroll, and take screenshots. It uses experimental
`Bun.WebView` with an installed Chrome, Chromium, Edge, or Brave on the machine
running phantombot; it never bundles a browser or attaches to your personal
browser. On macOS it explicitly selects Chrome too. Set `BUN_CHROME_PATH` if
automatic discovery cannot find your executable. Running from source requires
a Bun version that provides `Bun.WebView` (verified with 1.4.2).

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

Use `--session NAME` for another tab, and `--persona NAME` for another persona.
Tabs otherwise follow the current conversation (or `default` in a terminal).
Cookies and logins live in `<persona-dir>/browser/profile`, shared by that
persona's tabs. Untrusted turns use their own ephemeral scratch profile instead.
Each profile has its own lazy worker process, authenticated loopback endpoint,
eight-tab limit, 30-second operation deadline and five-minute idle shutdown.
Snapshots cap rendered text at 24,000 characters and interactive elements at
100; screenshot history is bounded to 32 PNGs in `browser/screenshots`.
The tool uses the installed browser's Chrome version and removes the headless
marker from its user agent before site navigation. Sites can still refuse access.
It does not disable Chrome's OS sandbox; restricted hosts need a browser that can
start under their local policy. Web content remains untrusted data.

