# Bounded security

## Default for untrusted turns (GHSA-w7w8)

Every untrusted turn (email, webhooks, `phantombot ask`, scheduled task wakes)
runs sandboxed by default. No policy file is needed; `{"version":1,"enabled":false,"grants":[]}`
in `security-policy.json` is the owner's opt-out. Trusted principal turns are
never sandboxed.

Inside the sandbox a turn has **network** and the **whole persona vault in
its environment**, so the work it was asked to do (git, gh, curl, APIs) runs as
it would on the host. Filesystem:

- **Writable:** only the turn's untrusted scratch dir (`$PHANTOMBOT_SCRATCH`,
  `<persona>/scratch/untrusted/<conversation>/<turn>/`), which is also the
  command's cwd and is deleted at turn end. The sandboxed-turn prompt tells the
  model this is the only place to work.
- **Read-only:** `~/.local/bin` (on `PATH`), `~/.ssh/*.pub`, `~/.gitconfig`,
  `~/.git-credentials` and every child of `~/.config` except `phantombot`,
  `phantomchat` and Chromium/Electron profiles (cookies or web storage, in the
  folder or one level down: browser sessions are not in the vault), so tool logins (gh, gog,
  gcloud, helm) work without a list,
  linked into the sandbox's neutral `HOME` so `~/…` resolves (Linux and macOS;
  Windows would need ACL changes on host folders, so it gets none).
- **Hidden:** everything else, including the persona folder (`identity.json`,
  the vault, prompt files, config and policy), SSH private keys, other personas
  and the rest of the home.

Host-only actions (notify, memory capture/search) go through the broker.

Threat model, stated on purpose:

- **Primary control: the judge.** Every untrusted turn is screened before it
  runs (decision model, with the harness judge as backup). Both hold at 90/100.
- **Second look: the escort.** When the decision model is configured, each
  sandbox command and broker host action is scored before it runs, at the same
  90/100 bar. It refuses one action and the turn carries on.
- **Blast radius: the sandbox.** A turn that gets through cannot touch host
  files, SSH keys, the vault key, other personas, host Unix sockets, or anything
  that outlives the turn's workspace.
- **Accepted risk.** A hijack the judge and escort both miss can send the
  secrets the turn holds (the persona vault) out over the network, or reach a
  service listening on the host's loopback (Linux/macOS). That is accepted over
  stripping network or credentials from autonomous work, which breaks the work
  itself. Per-job secret lists were rejected for the same reason: the admin
  falls on the owner and every new kind of job breaks until someone lists it.

The 90 bar replaces 70 (decision model, escort) and 80 (harness judge): the
false positives that held routine work scored 71-76. The scoring rubrics were
re-anchored with it, so clear threats (hijack, credential or data theft, money,
access changes, destruction) sit in the top band and other unsupported
privileged work is "doubtful", not held. Live eval at 90 on the bundled corpora
(`bun scripts/evalDecisionModelJudge.ts [--escort]`), five runs after the
re-anchor: judge 0 false negatives, 0 false positives (lowest hold 95, highest
allow 47 on the last three); escort 0 false positives, one 89 on a
credential-file read in 3 of 5 runs, whose follow-up step (posting it) holds
at 95.

## Owner-granted workflows

The owner chooses authority once; models do not grant permissions. The Judge
still screens the incoming untrusted message once. Operations outside the
sandbox and broker are refused as permission expansions, with no automatic
retry or model-generated grant. A sandbox error never falls back to host tools.

## Authority and lifecycle

The runtime reads the persona's `security-policy.json` before invoking the
harness. Embedders can use `persona.security.configure(policy)` and
`persona.security.policy()`. These are privileged application APIs, like
`persona.secrets.set`; do not expose them to untrusted end users or model tools.
An enabled policy selects only harnesses implementing the bounded tool surface
(native, and claude with its built-in tools off and the two tools served over
MCP from a runtime-owned working directory). A malformed policy fails; it cannot turn the feature off.
The native invocation disables extension, skill and context discovery and declares
only two tools. A blocking hook additionally rejects every other tool, including
codemode, raw MCP tools and alternate shell names.

The broker and grant credentials remain in the parent process. An authenticated
loopback channel carries structured requests from trusted tool implementations.
The sandbox child never gets its bearer token. It gets the persona vault as
environment variables (read-only reader; names a loader or runtime acts on, such
as `LD_*`, `NODE_*`, `BUN_*`, `PATH` and `HOME`, are dropped). Policy is never
mounted in its workspace.
Authority is detached from caller objects and snapshotted for the turn. Expiry is
checked on every call, and again before a review publication after its head read.
Closing the turn aborts local work, closes the broker and removes its workspace.

## OS boundaries

- Linux: glibc, x64/arm64, Landlock ABI 3 or newer, seccomp user notification and
  ADDFD are required. Filesystem writes are confined to the workspace; reads to
  the workspace plus the read-only host paths above. System executables/libraries/headers/share data, CPU counts,
  timezone and random/null devices are readable, as are DNS, TLS-root and
  `/usr/local` runtime files. OpenSSL and Git use clean configuration.
  AF_INET/AF_INET6 sockets are allowed; every other socket family (host Unix
  sockets, netlink, packet), host IPC, process inspection, namespace changes and
  process group escape are denied. A narrow notification supervisor supplies read-only
  descriptors for the requesting process's own maps/status/stat/statm/limits/
  cgroup files; it never grants the host's `/proc` tree. Other opens continue
  through Landlock, even if their path changes after inspection. No environment,
  file descriptor, host socket or loader setting is forwarded beyond stdio.
- macOS: `/usr/bin/sandbox-exec` applies a default-deny Seatbelt profile. Only
  system runtime files, DNS/TLS files, `/usr/local`, `/opt/homebrew`, the read-only host paths and the disposable workspace are accessible; network is allowed; arbitrary Mach IPC is denied; only system logging/user lookup, DNS and trust services are reachable. The OS must still provide this deprecated system facility.
- Windows: a private AppContainer profile with only the `internetClient`
  capability supplies the filesystem boundary (outbound network allowed; the
  host's loopback stays unreachable). Only the disposable directory gets an inherited
  writable ACL and low-integrity label. Launch uses a stdio-only handle list,
  suspended creation and mandatory Job assignment before resume. Job closure
  kills descendants; a 2 GiB aggregate memory limit and 128-process limit apply.

POSIX commands have a two-minute wall-clock ceiling and bounded output. Linux
also sets CPU, file-size, descriptor and per-user process limits. These are not
VMs: kernel vulnerabilities and a compromised principal OS account remain outside
this boundary. POSIX resource limits are not aggregate memory reservations, and
macOS process-group cleanup is weaker than Windows Job ownership. The isolation
contract is host files, the vault key and other personas, not immunity to all denial of service.
Build tools must already exist: the runtime copies an available Bun/Node binary
into the disposable workspace; it does not install developer toolchains.

## Grants and operations

Every grant has a unique `id` and an absolute `expiresAt` in Unix milliseconds.
Use explicit, short lifetimes. Setting `enabled` is the owner's choice to replace
legacy per-kind Escort rulings for that persona's bounded turns.

`broker({manifest:true})` lists the workspace and grants, excluding credential
names. `sandbox({command:"..."})` runs arbitrary shell commands there, with
network and the vault env; it has no host fallback. Commands can inspect, mutate, build, test and
remove their own disposable files. Text mentioning security commands is data,
not an execution-time phrase blacklist.

`broker({operation:{...}})` supports, with no grant needed:

- `notify`: `message` (to 4 KiB). Runs the persona's own `phantombot notify`.
- `memory-capture`: `text` (to 8 KiB), optional `tags` (decision, lesson,
  person, commitment, norm). `memory-search`: `query`, optional `limit` (1-20).

These run on the host with fixed argv, and are escorted like sandbox commands.
With a grant:

- `github-read`: `grant`, `resource` (`pull`, `files`, `comments`, `reviews`).
- `github-checkout`: `grant`, `head` (40 lowercase hex characters). Downloads
  exactly the verified current PR head and extracts it under `repository/` inside
  the sandbox. Archive extraction cannot modify host files.
- `github-review`: `grant`, `head`, `event` (`APPROVE`, `REQUEST_CHANGES`,
  `COMMENT`), `body`, optional inline `comments` with `path`, `line`, `side`,
  `body`. The broker checks the PR is open and its head matches immediately before
  publication; GitHub's `commit_id` binds the review to that head. A concurrent
  head update cannot turn an old-head verdict into a new-head review. Identical
  concurrent/repeated submissions are deduplicated within the session. Network
  uncertainty is reported, never automatically replayed.
- `npm-package`: `grant`, `name`, `version`. Only the fixed public npm registry
  tarball route is reachable. No credentials or arbitrary URL are accepted.
  Extraction stages Bun's offline cache. Stage the dependencies in the lockfile,
  then run `bun install --frozen-lockfile --offline`; package lifecycle scripts stay sandboxed.
- `http`: `grant`, optional `body`. URL, method and optional Bearer credential
  vault name are fixed by the owner's HTTP grant. Redirects are refused.
- `mcp`: `grant`, `arguments`. Server/tool are fixed in the grant, and arguments
  must match its entire JSON object (key order is immaterial). MCP transports are
  created by the runtime using its existing persona registry and vault.

A `github-review` grant fixes `repository` and `pullRequest`. A
`github-team-review` grant fixes `repository`, `reviewerLogin` and
`requesterLogins`; each GitHub operation supplies `pullRequest` and must have a
provider-authenticated matching `review_requested` timeline event that has not
been revoked or replaced by a request from an unauthorized actor. The broker
checks chronological timeline pages (up to 2,000 events, refusing longer histories),
and rechecks the request immediately before publishing a review. Email sender
text and repository instructions cannot establish this authority. Grants do not
automatically follow references to another repository/PR.

Broker requests are limited to 1 MiB, normal responses to 8 MiB, archive downloads
to 64 MiB and shell command text to 256 KiB. Outcomes distinguish policy denial,
expiry, stale head, payload bounds and service unavailability. Audit records have
only operation, grant id, outcome and duration, never credentials or raw bodies.

## Rollout gate

Run `tests/security-{broker,sandbox,session}.test.ts` and the compiled smoke on all
three supported OSes. These test real host-file denial, symlink/junction escape,
subprocess inheritance, network and the secret env, non-inet socket refusal
(Linux), Bun execution, timeout, authenticated IPC, deterministic grant bounds
and review publication semantics. The dedicated security-sandbox CI workflow
runs the platform matrix.

## Policy example

```json
{"version":1,"enabled":true,"grants":[
  {"id":"reviews","kind":"github-team-review","repository":"phantomyard/phantombot","reviewerLogin":"your-github-login","requesterLogins":["your-teammate"],"expiresAt":1800000000000},
  {"id":"packages","kind":"npm-registry","expiresAt":1800000000000}
]}
```
