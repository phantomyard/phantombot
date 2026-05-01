# Adding a harness

A harness is a CLI binary that takes a system prompt + a user message (and optionally history) and emits an assistant reply. Adding one means writing a class that implements the `Harness` interface in `src/harnesses/types.ts`.

## Recipe

1. **Pick a name.** Use the CLI's binary name: `claude`, `codex`, `gemini`, `pi`. The name becomes the harness `id` and the env-var prefix.

2. **Verify the CLI's `--print`-equivalent.** Every harness needs a non-interactive mode that:
   - Reads a prompt (from stdin or argv)
   - Accepts a system prompt override (a flag like `--system-prompt`)
   - Returns a streamable response on stdout
   - Exits cleanly on completion

   If a CLI doesn't have all three, the harness wrapper has to work harder. Document any quirks.

3. **Add the wrapper file** `src/harnesses/<name>.ts`. Use `src/harnesses/claude.ts` as the template. The shape:

   ```ts
   export class FooHarness implements Harness {
     id = 'foo';

     async available(): Promise<boolean> {
       // verify the binary exists and basic auth works
     }

     async *invoke(req: HarnessRequest): AsyncIterable<HarnessChunk> {
       // 1. spawn the CLI subprocess
       // 2. write req.userMessage (and history) to stdin
       // 3. stream stdout, parse it, yield HarnessChunk events
       // 4. on close/error, yield a 'done' or 'error' chunk
     }
   }
   ```

4. **Document its env vars** in `.env.example`. By convention:
   - `PHANTOMBOT_<NAME>_BIN` — override the CLI binary path
   - `PHANTOMBOT_<NAME>_MODEL` — model selector if applicable
   - any auth-related env vars the CLI needs (these will already be read by the CLI itself when spawned; phantombot doesn't need to know them)

5. **Register the harness** in `src/index.ts`'s harness registry.

6. **Add it to `PHANTOMBOT_HARNESS_CHAIN`** in your `.env` if you want it in the fallback chain.

## What a "good" harness wrapper looks like

- **Stateless.** Each `invoke()` is independent. No instance state across calls beyond config.
- **Streams text early.** If the CLI emits anything (thinking traces, intermediate output), forward it as `progress` chunks so the orchestrator can keep the channel alive past long timeouts.
- **Distinguishes recoverable from terminal errors.** A 429 / rate-limit is recoverable (try the next harness). A bad system prompt or missing binary is terminal (fail the whole turn). Set `recoverable: true|false` on `HarnessChunk` errors accordingly.
- **Respects `req.timeoutMs`.** If the subprocess hasn't emitted anything in `timeoutMs`, kill it and yield a recoverable error.
- **Doesn't try to translate tools.** The harness's tools belong to the harness. Phantombot won't send `tools[]` and the harness won't return `tool_calls`.

## Reference: the Claude harness

`src/harnesses/claude.ts` carries over patches that were originally applied to a fork of `claude-max-api-proxy`:

- **Prompt via stdin, not argv.** Linux `ARG_MAX` (~2 MB) is a real ceiling for large persona/memory contexts.
- **`--system-prompt` (not embedded in the prompt body).** Otherwise Claude Code interprets the persona as user-input data and often shortcuts to terse / sentinel responses.
- **`--permission-mode bypassPermissions`.** In `--print` mode there's no human to approve tool use.
- **`--fallback-model sonnet`.** When Opus rate-limits, Claude Code transparently retries on Sonnet within the same subprocess and same Max subscription.
- **No `--bare`.** `--bare` requires `ANTHROPIC_API_KEY` and refuses OAuth/keychain credentials, which breaks the Claude Max subscription path.

When adding the Codex / Gemini / Pi harnesses, expect to repeat the equivalent investigations for *those* CLIs. Read each CLI's `--help` carefully and document any equivalent gotchas in the wrapper file.
