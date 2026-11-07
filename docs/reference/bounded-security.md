# Bounded security

Bounded mode is ON by default for untrusted turns (GHSA-w7w8, #783): outside
content, `phantombot ask` and scheduled tasks. The owner chooses authority once;
models do not grant permissions. The Judge still screens the incoming untrusted
message once. Within a bounded turn, local commands never go through Escort, and
of brokered calls only `memory-capture` and `host-command` do (an allowed kind
passes unjudged; a denied kind is refused). The PR loop and `notify` are bounded
by the broker allowlist alone, so unattended PR work is never held.

## Default grants

With no `security-policy.json` a persona gets `github` (repository `*`),
`npm-registry`, `notify` and `memory`. A policy file REPLACES them (list them
again to keep them); `{"version":1,"enabled":false,"grants":[]}` opts out.

- `github-clone` / `github-push`: the host clones with the persona's vault
  token (`GITHUB_TOKEN`, `GH_TOKEN`, then `gh auth token`) and hands the sandbox
  a tarball; a push bundles a committed sha INSIDE the sandbox and the host
  fetches it into a fresh bare repo it owns, so host git never reads a
  sandbox-written repository. The default branch is refused.
- `github-api`: any GET and GraphQL query; writes only to PR create/edit
  (title/body), reviews, review comments/replies, issue comments, thread
  resolve, requested reviewers, labels and workflow re-runs. GraphQL mutations
  are allowlisted per field after strings are removed; comments are refused.
  Merge, auto-merge, settings, refs and the default branch are never brokered.
- `notify`, `memory-capture`, `memory-search` run `phantombot` on the host for
  this persona. `host-command` runs one exact owner-granted argv (optionally
  with model arguments when `extraArgs` is true) — e.g. a mail helper for an
  inbox poller.
- A bounded turn's prompt gets a "Sandboxed turn" overlay mapping the persona's
  usual host commands to these operations.
Operations outside those boundaries are refused as permission expansions, with
no automatic retry or model-generated grant. Trusted principal turns retain their
existing tools. The old Escort remains the compatibility path while bounded mode
is disabled, not a fallback after a sandbox error.

## Authority and lifecycle

The runtime reads the persona's `security-policy.json` before invoking the
harness. Embedders can use `persona.security.configure(policy)` and
`persona.security.policy()`. These are privileged application APIs, like
`persona.secrets.set`; do not expose them to untrusted end users or model tools.
An enabled policy selects only harnesses implementing the bounded tool surface
(native, and claude with its built-in tools off and the two tools served over a
phantombot stdio MCP server, vault env stripped). A malformed policy fails; it cannot turn the feature off.
The native invocation disables extension, skill and context discovery and declares
only two tools. A blocking hook additionally rejects every other tool, including
codemode, raw MCP tools and alternate shell names.

The broker and credentials remain in the parent process. An authenticated
loopback channel carries structured requests from trusted tool implementations.
The sandbox child has neither its bearer token nor credential environment
variables. It cannot reach loopback. Policy is never mounted in its workspace.
Authority is detached from caller objects and snapshotted for the turn. Expiry is
checked on every call, and again before a review publication after its head read.
Closing the turn aborts local work, closes the broker and removes its workspace.

## OS boundaries

- Linux: glibc, x64/arm64, Landlock ABI 3 or newer, seccomp user notification and
  ADDFD are required. Filesystem writes and arbitrary file reads are confined to
  the workspace. System executables/libraries/headers/share data, CPU counts,
  timezone and random/null devices are readable. OpenSSL and Git use clean configuration.
  Direct networking, host IPC, process inspection, namespace changes and process
  group escape are denied. A narrow notification supervisor supplies read-only
  descriptors for the requesting process's own maps/status/stat/statm/limits/
  cgroup files; it never grants the host's `/proc` tree. Other opens continue
  through Landlock, even if their path changes after inspection. No environment,
  file descriptor, host socket or loader setting is forwarded beyond stdio.
- macOS: `/usr/bin/sandbox-exec` applies a default-deny Seatbelt profile. Only
  system runtime files and the disposable workspace are accessible; network and arbitrary Mach IPC are denied; only system logging/user lookup services are reachable. The OS must still provide this deprecated system facility.
- Windows: a private AppContainer profile with no capabilities supplies the
  filesystem/network boundary. Only the disposable directory gets an inherited
  writable ACL and low-integrity label. Launch uses a stdio-only handle list,
  suspended creation and mandatory Job assignment before resume. Job closure
  kills descendants; a 2 GiB aggregate memory limit and 128-process limit apply.

POSIX commands have a two-minute wall-clock ceiling and bounded output. Linux
also sets CPU, file-size, descriptor and per-user process limits. These are not
VMs: kernel vulnerabilities and a compromised principal OS account remain outside
this boundary. POSIX resource limits are not aggregate memory reservations, and
macOS process-group cleanup is weaker than Windows Job ownership. The isolation
contract is files, credentials and network, not immunity to all denial of service.
Build tools must already exist: the runtime copies an available Bun/Node binary
into the disposable workspace; it does not install developer toolchains.

## Grants and operations

Every grant has a unique `id` and an absolute `expiresAt` in Unix milliseconds.
Use explicit, short lifetimes. Setting `enabled` is the owner's choice to replace
legacy per-kind Escort rulings for that persona's bounded turns.

`broker({manifest:true})` lists the workspace and grants, excluding credential
names. `sandbox({command:"..."})` runs arbitrary shell commands there; it has no
host or direct network fallback. Commands can inspect, mutate, build, test and
remove their own disposable files. Text mentioning security commands is data,
not an execution-time phrase blacklist.

`broker({operation:{...}})` supports:

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
subprocess inheritance, loopback blocking, Bun execution, timeout, authenticated
IPC, deterministic grant bounds and review publication semantics. The dedicated
security-sandbox CI workflow runs the platform matrix.
`tests/security-default-on.test.ts` proves the default, the allowlist and the
escort boundary.

## Policy example

```json
{"version":1,"enabled":true,"grants":[
  {"id":"reviews","kind":"github-team-review","repository":"phantomyard/phantombot","reviewerLogin":"your-github-login","requesterLogins":["your-teammate"],"expiresAt":1800000000000},
  {"id":"packages","kind":"npm-registry","expiresAt":1800000000000}
]}
```
