# Adding a harness

A harness is a CLI binary that takes a system prompt + a user message (and optionally history) and emits an assistant reply. Adding one means writing a class that implements the `Harness` interface in `src/harnesses/types.ts`.

## Recipe

1. **Pick a name.** Use the CLI's binary name: `claude`, `pi`, `gemini`, `codex`, etc. The name becomes the harness `id` and the env-var prefix.

2. **Verify the CLI's `--print`-equivalent.** Every harness needs a non-interactive mode that:
   - Reads a prompt (from stdin or argv)
   - Accepts a system-prompt override (a flag like `--system-prompt`)
   - Returns a streamable response on stdout
   - Exits cleanly on completion

   If a CLI doesn't have all three, the harness wrapper has to work harder. Document any quirks in the wrapper file.

3. **Add the wrapper file** at `src/harnesses/<name>.ts`. Use `src/harnesses/claude.ts` (stdin payload + filtered env for OAuth) or `src/harnesses/pi.ts` (argv payload + `maxPayloadBytes` guard) as the template. The shape:

   ```ts
   export class FooHarness implements Harness {
     readonly id = 'foo';
     readonly maxPayloadBytes?: number;  // declare if argv-bounded; omit if stdin

     async available(): Promise<boolean> {
       // verify the binary exists
     }

     async *invoke(req: HarnessRequest): AsyncGenerator<HarnessChunk> {
       // 1. spawn the CLI subprocess via Bun.spawn
       // 2. write req.userMessage (and history) to stdin OR pass as argv
       // 3. stream stdout, parse it, yield text/progress/done/error chunks
       // 4. on timeout: kill SIGTERM, mark state, yield error/recoverable
       // 5. on exit: emit done (code 0) or error (recoverable: code !== 127)
     }
   }
   ```

4. **Register** in `src/cli/ask.ts` (`buildHarnessChain`) and `src/repl/index.ts` (its own `buildHarnessChain`). They're hand-rolled `if/else if` ladders, not a registry — keeps the chain order explicit.

5. **Add config defaults** in `src/config.ts` under `Config.harnesses.<name>` and the corresponding parser code, plus env-var overrides (`PHANTOMBOT_<NAME>_BIN`, `PHANTOMBOT_<NAME>_MODEL`, etc.).

6. **Add a `phantombot doctor` check** in `src/cli/doctor.ts` to surface auth / binary problems clearly.

7. **Add tests.** Use `src/harnesses/{claude,pi}.test.ts` as the template:
   - Pure-function tests for `renderPayload` / `parseStreamJson` equivalents.
   - End-to-end via a `tests/fixtures/fake-<name>.sh` script (use `exec sleep` for the hang/timeout case so SIGTERM reaches the actual blocking process).

## What a "good" harness wrapper looks like

- **Stateless.** Each `invoke()` is independent. No instance state across calls beyond config.
- **Streams text early.** Forward intermediate output as `progress` chunks so users see something happening on long turns.
- **Distinguishes recoverable from terminal errors.** A 429 / rate-limit / network blip is recoverable (try the next harness). A bad auth / missing binary (exit 127) is terminal. Set `recoverable` accordingly.
- **Respects `req.timeoutMs`.** Track a state machine: `running | timed_out | exited`. On timeout, kill the subprocess and emit a recoverable error — DO NOT also emit a `done` chunk with whatever partial text accumulated. (This bug existed in the Node skeleton; the Bun port at `src/harnesses/claude.ts` fixes it. Don't reintroduce it.)
- **Doesn't try to translate tools.** The harness's tools belong to the harness. Phantombot won't send `tools[]` and the harness won't return `tool_calls` to phantombot. See the bottom-of-file warning in `claude.ts`.
- **Filters secrets when appropriate.** If your harness uses OAuth on the host, strip the corresponding `*_API_KEY` from the subprocess env (see `filterAuthEnv` in `claude.ts`) so the OAuth path is forced.

## Reference: the Claude harness

`src/harnesses/claude.ts` carries over patches that were originally applied to a fork of `claude-max-api-proxy`:

- **Prompt via stdin, not argv.** Linux `ARG_MAX` (~2 MB) is a real ceiling for large persona/memory contexts.
- **`--system-prompt` (not embedded in the prompt body).** Otherwise Claude Code interprets the persona as user-input data and often shortcuts to terse / sentinel responses.
- **`--permission-mode bypassPermissions`.** In `--print` mode there's no human to approve tool use.
- **`--fallback-model sonnet`.** When Opus rate-limits, Claude Code transparently retries on Sonnet within the same subprocess and same Max subscription.
- **No `--bare`.** `--bare` requires `ANTHROPIC_API_KEY` and refuses OAuth/keychain credentials, which breaks the Claude Max subscription path.

## Reference: the Pi harness

`src/harnesses/pi.ts` is structurally similar to claude.ts but:

- **Payload via argv** (Pi ignores stdin in `--print` mode). Declares `maxPayloadBytes` so the orchestrator can pre-skip oversize turns.
- **No `--api-key`** — phantombot's OAuth-on-host model trusts Pi's own configured credentials.
- Different stream-json schema: `message_update` events with `text_delta` → text chunks; `tool_execution_start` → progress chunks.

When adding a third harness (Codex / Gemini / etc.), expect to repeat the equivalent investigations for *that* CLI. Read its `--help` carefully and document any equivalent gotchas in the wrapper file.
