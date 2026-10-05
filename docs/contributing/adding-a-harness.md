# Add a harness

A harness adapts a model CLI or embedded engine to Phantombot's streaming turn
contract. Read [AGENTS.md](../../AGENTS.md) first; the watchdog, completion,
trust, environment, and failover invariants are part of the API.

## Implement the adapter

1. Add `src/harnesses/<name>.ts` implementing `Harness` from
   `src/harnesses/types.ts`.
2. Report availability without mutating host state.
3. Translate `HarnessRequest` into the native non-interactive invocation.
4. Stream typed text, progress, tool-boundary, done, and error chunks.
5. Preserve parser-native tool call IDs. Names and progress text are not stable
   identifiers when calls run concurrently.
6. Use the shared runner for process ownership, aborts, idle watching, and hard
   tool timeouts.
7. Emit an explicit completion marker. Exit code zero without completion is a
   truncated turn, not success.

Use the Claude adapter for stdin payloads, the Pi adapter for the embedded and
host engine, and the Codex adapter for event parsing and sandbox behavior.

## Register it once

Add the harness to `src/harnesses/buildChain.ts`, the shared registry used by
every turn entry point. Do not add separate ladders to `ask`, the daemon, ACP,
or the TUI.

Add configuration parsing, interactive setup, availability reporting, doctor
coverage, and the public documentation needed for users to select it. Optional
host harnesses are never installed automatically.

## Test the real contract

Cover:

- binary discovery and service PATH behavior;
- streaming parser output, tool start/end pairing, and completion;
- recoverable versus terminal errors;
- abort and process-tree cleanup;
- `tools: "none"` behavior and threat-screen eligibility;
- oversized payload handling;
- fallback to and from neighboring harnesses.

Run the focused suites, typecheck, and the full suite. Then verify the real CLI
on every platform whose spawn or signal behavior changed.

See [harness detection](../operations/harness-detection.md) for executable
resolution.
