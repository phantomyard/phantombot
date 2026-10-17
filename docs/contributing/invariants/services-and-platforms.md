# Services and platforms — contributor invariants

Part of the phantombot contributor guide: systemd / launchd / Task Scheduler units, self-heal, macOS signing, Windows PATH. The index of every invariant is in [`/AGENTS.md`](../../../AGENTS.md). Numbers are stable identifiers — code comments and tests cite them — so a new rule takes the next free number and nothing is renumbered or reused (the one-time renumbering into 71–73 and 77 is recorded in AGENTS.md). Each rule records a real incident; a deliberate, documented trade-off is not a defect.

## Service model (systemd + launchd + Windows Task Scheduler)

Phantombot ships on **Linux (systemd --user)**, **macOS (launchd, per-user LaunchAgents)**, and **Windows (per-user Task Scheduler logon task plus three periodic tasks)**. `lib/platform.ts` is the single router that decides which backend to talk to; each backend sits behind a common `ServiceControl` surface with an injectable runner so tests never touch the real service manager. Windows uses `InteractiveToken` and the current user's SID, so installation needs no password or elevation; installation preserves healthy existing task definitions and only repairs missing/stale entries. Windows `start`/`restart` re-enable the task and use a hidden native detached launch for SSH/terminal control because Task Scheduler cannot `/Run` an interactive-token task from a non-interactive session. `windowsJob.ts` assigns harness children to kill-on-close Job Objects.

On Linux, `phantombot install` creates **three** systemd-user units:

| Unit | Cadence | What it does |
|---|---|---|
| `phantombot.service` | always-on | `phantombot run` — Telegram listener |
| `phantombot-heartbeat@<persona>.timer` → `@.service` template | every 30 min, one instance per served persona (default ∪ autostart) | mechanical maintenance for that persona, no LLM |
| `phantombot-tick.timer` → `.service` | every 1 min | fires due scheduled tasks |

There is deliberately no nightly unit. The cognitive pass is event-driven —
`run` fires a sweep at startup, and the heartbeat fires one when it notices the
calendar day changed since its last fire. A clock would miss the day entirely on
any box that sleeps at 02:00. Installs that predate this have their
`phantombot-nightly.timer` stopped, disabled and deleted on the next heartbeat.

A nightly stage is deliberately the **narrowest turn phantombot runs**: no MCP
(`mcpMode: "none"`), cwd pinned to the persona dir, and a positive tool grant of
`NIGHTLY_TOOLS` = `Bash,Read,Write,Edit` (`toolsMode: { allow }`, #387). The
allowlist exists to drop claude's native `Glob`/`Grep`, whose parallel workers
recursively walk the tree from cwd; a stage searches through
`phantombot memory search` (an index query), never a filesystem walk. Note the
grant is claude-only — pi and codex have no positive-grant flag and ignore it —
so treat it as defence-in-depth, **not** a trust boundary. `toolsMode: "none"`
is the real boundary, and it's reserved for the threat judge.

Services carry **no `EnvironmentFile=` lines** (#452). They used to source `~/.config/phantombot/.env` and `~/.env`, which made those plaintext files authoritative in practice while the docs called the vault canonical — and gave macOS (whose launchd plists cannot source a file) a permanently different credential path.

Credentials now travel one way on every platform: `loadVaultIntoEnv()` decrypts the ACTIVE persona's vault at startup and injects it into `process.env`, and each harness calls `reloadVaultForPersona()` before a spawn so a `phantombot vault set` from the previous turn is visible without a restart. An existing shell export always wins over a vault value, exactly as it did over the old files.

Service units also set a deterministic `PATH` that includes `~/.local/bin` plus stable user harness shim locations such as `~/.local/share/pi-node/bin` and `~/.local/share/pi-node/current/bin`. Do not rely on interactive shell startup files for service harness discovery. When Phantombot finds a harness in PATH or common npm/pi-node versioned locations, it saves the absolute path in `state.json` and executes that path directly on later starts. `phantombot run` must never fail startup just because a harness binary is missing; log loudly, keep the headless service alive, and let `phantombot doctor` report/repair the configured chain. Windows keep-alive tasks invoke `phantombot run --if-not-running`, which treats an existing run lock as a silent success; foreground invocations retain the diagnostic error.

**Service log retention (`src/lib/logRotate.ts`, #428).** Only macOS and Windows
need it: on Linux the units log to journald, which owns retention, so
`serviceLogDir()` returns `null` there and rotation is a no-op. Everywhere else
phantombot writes plain files (`~/Library/Logs/phantombot/`,
`<data>/phantombot/logs/`) that nothing ever capped — one macOS box reached
~700 MB. The **heartbeat** rotates them (every 30 min), because it is already
the host maintenance pass that heals units and scheduled tasks, so this needs no
new timer and inherits the same platform dispatch. Defaults are 16 MiB per file
and 3 retained generations (~64 MB per log worst case), overridable with
`PHANTOMBOT_LOG_MAX_BYTES` and `PHANTOMBOT_LOG_KEEP`; a junk or negative value
falls back to the default rather than disabling rotation, and `keep=0` discards
existing generations instead of stranding them. Three invariants that look like
tidy-up candidates and are not. **Rotation is COPY-TRUNCATE, never rename** —
the live file is held open by a process we do not control (launchd, the Windows
`cmd >>` wrapper) with an O_APPEND descriptor, and a descriptor follows the
INODE, so renaming the live file leaves the writer appending to the renamed
inode forever while the new log stays empty. **The live copy is staged to a
temporary file in the same directory BEFORE any generation is pruned or
shifted**, and published with a rename: the copy is the step that fails
(Windows EBUSY/EACCES on a log held by its writer), and pruning first means a
permanently unrotatable file ages its generations away on every heartbeat
without ever writing a new snapshot — retained history destroyed by the thing
meant to retain it. **The directory lock is ownership-aware**: takeover of a
stale lock is serialised by a second exclusive `wx` create and re-validated
under it, because every contender reads the same stale timestamp and a plain
overwrite lets all of them decide they won; release is gated on the token the
holder wrote, so a pass whose lock was stolen cannot delete its successor's.
The whole thing is guarded on `isPhantombotBinary`, so a dev run or a stray test
cannot truncate a developer's real logs.

If you change a unit body (any `generate*` function in `src/lib/systemd.ts`), `ensureUnitCurrent` will detect the on-disk unit as stale on the next `phantombot voice` / `phantombot harness` / etc. run and rewrite it automatically. The previous body is preserved as `${unitPath}.bak` for rollback.

**`PHANTOMBOT_SANDBOX` is a GLOBAL kill-switch, not a TUI one (#484).** When it
is set to anything but `""` or `0`, `defaultServiceControl()` wraps the host
backend in `sandboxServiceControl()`: `isActive()` still delegates (queries tell
the truth), while `start`, `stop`, `restart` and `rerenderUnitIfStale` become
no-ops that report `ok: true`. It exists so a `bun run src/index.ts` dev
checkout cannot bounce the host's real `phantombot.service` — the daemon serving
live conversations — when your branch saves config.

The trap is the blast radius. `defaultServiceControl()` has ~15 callers,
including `cli/update.ts`, `lib/serviceLifecycle.ts` and `channels/commands.ts`,
and most of them only check `ok`. So on a host with the variable set, `/update`
and `/restart` report success while restarting nothing. Each of those three
therefore logs `platform: service change suppressed` at **warn** with
`reason: "PHANTOMBOT_SANDBOX"` and the op name — that line is the only signal
a caller who ignores `stderr` will ever see, so **do not remove it when adding
a mutation to `ServiceControl`**: a new verb that suppresses silently
reintroduces exactly this bug.

`rerenderUnitIfStale` logs the same fields at **info**
(`platform: unit re-render skipped`), not warn: it returns `{rerendered: false}`
rather than a false success, and that is what the real backend returns under
`bun run` anyway (`defaultRerenderUnitIfStale` bails on `isPhantombotBinary`).
Warning on a call that would not have written anything is how a warn line
gets ignored. The line goes to the stderr of whichever process has the
variable set — your terminal in a dev checkout, the TUI's `^l` pane, and the
service journal only if the daemon itself was started with it.

## Invariants

<a id="inv-17"></a>
### 17. macOS code-signing must shell out to `/usr/bin/openssl` (LibreSSL), never a PATH-resolved `openssl`.

`src/lib/macSigning.ts` builds the self-signed identity by generating a cert + PKCS#12 with openssl, then importing it via `security import`. The launchd environment phantombot runs under (and therefore the `/update` re-sign path) puts `/opt/homebrew/bin` **ahead** of `/usr/bin` on `PATH`, so a bare `openssl` resolves to Homebrew's OpenSSL 3.x. Its `pkcs12 -export` writes the MAC/PBE with modern algorithms that Apple's LibreSSL-era `security import` rejects with `MAC verification failed during PKCS12 import` — which silently failed the import step of **every** macOS `/update` re-sign (rollback → binary stays ad-hoc → TCC keeps nagging). Pin both calls to the exported `OPENSSL_BIN` (`/usr/bin/openssl`), the system LibreSSL that is always present and produces import-compatible p12s. `-legacy` is **not** the fix — that flag is an OpenSSL-3-ism and errors on LibreSSL. This is a distinct bug from the #363 keychain-search-list fix (which is downstream, at the codesign step); both are needed. **Dogfooding:** the `/update resign` chat subcommand (`handleUpdateResign` in `src/channels/commands.ts`, reusing `runFixSigning`) re-signs the current on-disk binary in place — no download/reinstall/restart/version-change — so this launchd-context bug can be reproduced and verified without cutting a release. It runs the same routine `/update` applies post-swap; macOS-only, a friendly no-op elsewhere. Because it's a user-facing chat command, its behaviour is documented in the `/update` row of `README.md`.

<a id="inv-25"></a>
### 25. Exit 143 from a self-restart is our own cgroup teardown, not a failed restart (issue #408).

`defaultSystemdServiceControl().restart()` spawns `systemctl` **inside phantombot's own cgroup**, so the moment systemd accepts the restart job and begins the stop it SIGTERMs that child too — which Bun surfaces as exit 143 (128+SIGTERM). `SELF_RESTART_ARGS` carries `--no-block` and its old comment claimed that *prevented* this; it does not. Nothing orders "systemctl exits 0" before "systemd kills the cgroup", so on a fast host the flag loses the race and every **successful** Linux `/update` logged `updateNotify: restart failed after binary swap` at `error` level, while the unit was already restarting. That is worse than cosmetic: it is the fleet's only "the update did not come back" signal, so making it fire on every update trains humans and log-scrapers to ignore the one line that should page. The classification lives in `isSelfRestartTeardown` (`src/lib/systemd.ts`) and is applied by `runSelfRestart`, which is the extracted body of `restart()` precisely so it can be tested against a fake runner instead of a live user-systemd bus. Three deliberate edges: **137/SIGKILL is NOT included** — that's the OOM killer or a hard kill, a real fault, the same line the harness classifier draws (invariant in `lib/harnessAlert.ts`'s neighbourhood); **any other non-zero exit still fails** so a bad unit name or an unreachable session bus surfaces normally; and it is scoped to `restart()` only — **not** because restart is the internal verb and stop the external one (it isn't: `phantombot update --restart` in `src/cli/update.ts` and `src/cli/harness.ts` both reach `restart()` from a terminal), but because `restart()` is the only verb that can be issued from **inside the unit it acts on**; a self-`stop()` would never come back, so `stop()` is always issued from outside the doomed cgroup and a SIGTERM'd `systemctl` there is a real interruption. 143 stays correct for the external `restart()` callers too, since that CLI is usually itself spawned from inside the running service and shares the cgroup; the residual case (a genuinely detached CLI whose `systemctl` child is SIGTERM'd for an unrelated reason) reports an indistinguishable success, which is accepted as rarer and cheaper than crying failure on every successful update. The Windows path is unrelated: there `ok:false` means the deferred relaunch failed to schedule, which is genuinely broken. The unit template has declared `SuccessExitStatus=143` for this exact reason since day one; this is the same judgement finally applied to the code path.

<a id="inv-37"></a>
### 37. macOS maintenance is one LaunchAgent PER SERVED PERSONA, and launchd state may never be updated ahead of a CONFIRMED unload (issue #491).

The systemd per-persona model (#486) has a launchd mirror: `install`/`ensureLaunchdHeartbeatInstances` (`src/lib/launchd.ts`) write one `dev.phantombot.heartbeat.<persona>` plist per served persona (default FIRST — the `servedPersonasOf` contract), reconcile them idempotently from the install, the persona lifecycle sync and the heartbeat's periodic heal (dispatched per platform by `syncHeartbeatInstances` in `lib/platform.ts`), and retire the legacy single `dev.phantombot.heartbeat` plist only AFTER the default persona's replacement is verifiably loaded — a failed bootstrap keeps the legacy heartbeat so the host always keeps A heartbeat. The load-bearing rule, and the failure each violation re-opens, is **launchd state changes are sequenced disk←→launchd, never launchd←→disk**: (a) never REWRITE a plist while its stale job is still loaded — `print` first, `bootout` first, and only a successful bootout lets the new body reach disk; a failed bootout with the new body already written leaves launchd running the OLD job while the file matches `expected`, and the next heal then sees `print` ok + content clean and mistakes that stale in-memory job for a healthy reload FOREVER — the exact mask Kai caught in #494 review. On bootout failure the heal records the label in `reloadFailed`, leaves the old body (which matches the loaded job), and retries on the next pass. (b) never UNLINK a plist until the unload is CONFIRMED — `confirmedUnload()` is the single gate (bootout succeeds, or a `print` probe verifies the job is absent): a transient bootout failure must keep the file, because the plist is the only handle a later heal or install has to find and retry the unload; deleting it leaves a registered job with nothing on disk pointing at it. This applies to every retirement path — unserved personas, the legacy plist, the old nightly timer — all of which report what they could not do (`removed`/`removeFailed`/`reloadFailed`/`retiredLegacy`) instead of claiming success. Uninstall is deliberately exempt (best-effort bootout + delete everything — the operator asked for deletion, and rerunning is the recovery). Documented in the README's macOS LaunchAgents paragraph; if you change the labels, the sequencing or the retirement rule, update both files.

<a id="inv-41"></a>
### 41. Host maintenance must be healable from a path that does not depend on the thing being healed (issue #510).

The per-persona maintenance migration (#486/#490/#494) originally ran only from the HEARTBEAT plus `install` and the persona-lifecycle sync — i.e. only from code the scheduled job itself had to be alive to reach. Self-update swaps the binary and touches no units, so a scheduler that died first was permanently unrecoverable: host `matt`'s launchd heartbeat started returning exit 78, went 41h stale while the daemon was healthy and current, and only a hand-run `phantombot heartbeat` fixed it. The rule: **any self-heal whose only trigger is the failed component is not a self-heal.** `src/lib/maintenanceHeal.ts` owns the dispatch (`healMaintenanceUnits`) and is now called from three independent lifecycles — the heartbeat, `phantombot run` at daemon start (a process no scheduler owns), and `phantombot tick` (a SEPARATE scheduled job, its own plist/timer), so heartbeat and tick must fail together before a host goes unmaintained. The tick path (`healStaleMaintenanceFromTick`) is gated three ways because tick fires every minute — installed binary only, only when `staleMaintenancePersonas` finds a served persona past `HEARTBEAT_STALE_MINUTES` (a MISSING marker counts as stale: an instance that never bootstrapped never writes one), and then at most once per `TICK_HEAL_MIN_INTERVAL_MINUTES`. Those gates live in the lib, not inline in `tick.ts`, so tests exercise the gates rather than a seam. Corollary for retirement work: a cleanup that only `install` performs never reaches a host that self-updates — the launchd heal now retires the dead `dev.phantombot.nightly` plist too, under the same confirmed-unload rule as [invariant 37](#inv-37). Tests: `tests/lib-maintenanceHeal.test.ts`, `tests/lib-launchd.test.ts`.

<a id="inv-51"></a>
### 51. Registering a service is not starting one — "installed" must mean the same thing on all three platforms.

Linux `install` enables AND `start`s the unit; macOS `bootstrap` plus `RunAtLoad` starts immediately; Windows only ever ran `schtasks /Create`, so the daemon appeared at the next logon or whenever the always-on task's 1-minute keep-alive `TimeTrigger` caught up — an installer that exits with nothing running. `installPhantombotTasks` now ends with `schtasks /Run` on the main task, which is safe to issue unconditionally because the task carries `MultipleInstancesPolicy=IgnoreNew` (a `/Run` against a live daemon is ignored, never a second supervisor). A start that does not take is a WARNING, not a failed install: the tasks are registered and the keep-alive trigger still recovers. Tests: `tests/lib-taskScheduler.test.ts`.

<a id="inv-67"></a>
### 67. On Windows PATH is spelled `Path`, and a persona gets the full interactive-login PATH (issue #647).

`process.env` is case-insensitive on Windows, but every harness builds its child env by SPREADING it into a plain object, where the key keeps its original case (`Path`) and lookups turn case-sensitive. The PATH helpers in `src/lib/processGroup.ts` read `env.PATH`, saw `undefined`, and wrote a second `PATH` variable holding only phantombot's own dirs; the child resolved that one, lost `C:\Windows\System32`, and pi's `where powershell.exe` died with ENOENT on `where` itself — "No PowerShell executable found" on a fresh box, with Git Bash the only shell that worked (pi probes its install dir directly). Rules: (a) never read or write `env.PATH` directly in spawn code — go through `prependToPath` / `pathKeyOf` / `normalizePathKey` (`src/lib/windowsPath.ts`), which find the real key and collapse case duplicates; (b) `spawnInNewSession` appends the machine + user PATH read fresh from the registry (`withWindowsLoginPath`, 30 s cache, `reg.exe` by absolute path), so a child is never narrower than the user's own PowerShell/SSH session and software installed after the daemon started is found without a restart; (c) this is additive only — do NOT trim, allow-list or "sanitise" PATH on Windows. PATH failures there are silent and cost a whole onboarding to diagnose. Tests: `tests/lib-windowsPath.test.ts` (Windows behaviour driven through the injectable `platform`, so Linux CI pins it).
