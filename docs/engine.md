# Embedding the engine (`phantombot/engine`)

Phantombot's engine can be imported as a TypeScript library. An application
gets the same machinery the daemon runs: personas, memory and retrieval, the
threat screen, and the harness chain with fallback and watchdogs. The decision
model slot is included too. You do not run a daemon, a Telegram bot or a CLI
subprocess to get it.

```ts
import { createEngine } from "phantombot/engine";

const engine = await createEngine({ root: "/srv/myapp/phantom" });
const aria = (await engine.personas.exists("aria"))
  ? engine.persona("aria")
  : await engine.personas.create("aria", { identity: "the support assistant for Acme" });

await aria.configure({
  brain: {
    native: { provider: "openrouter", model: "z-ai/glm-5.3-flash", apiKey: process.env.OPENROUTER_API_KEY },
  },
  decisionModel: { provider: "openrouter", apiKey: process.env.OPENROUTER_API_KEY, judge: true },
});

for await (const ev of aria.turn({ source: "untrusted", conversation: "user-42", message: userText })) {
  if (ev.type === "text") process.stdout.write(ev.text);
  if (ev.type === "held") console.log("held for review:", ev.message);
}

await engine.close();
```

## Requirements

- **Bun.** The engine uses `bun:sqlite` and `Bun.spawn`, like the CLI. Node and
  Deno are not supported yet.
- **A harness.** The default `native` harness is the Pi engine that phantombot
  embeds, so it needs only a provider and an API key. `pi-host`, `claude` and
  `codex` use the host's installed CLIs, exactly as the daemon does.

## Installing

Depend on a release tag. Every merge to `main` is tagged `v1.1.<N>` (see the
README's release rings). A tag is a promoted, stable release only once it
appears on the stable ring.

```bash
bun add github:phantomyard/phantombot#v1.1.<N>
```

```json
{ "dependencies": { "phantombot": "github:phantomyard/phantombot#v1.1.<N>" } }
```

- **No build step.** The package ships its TypeScript sources and the public
  declarations committed in `types/engine/`. `phantombot/engine` resolves
  `types` there, so your typecheck sees only the public API, never
  phantombot's internals.
- **Hoisted installs work.** Bun places phantombot's dependencies next to it,
  pi included. The embedded engine finds pi through its package root, not a
  fixed `node_modules` path.
- **Two blocked install scripts are expected.** Bun reports them after
  install. `@google/genai`'s preinstall is a no-op and `protobufjs`'s
  postinstall is a version notice. The engine needs neither, so leave them
  untrusted.

For development against a local checkout:

```bash
cd phantombot && bun install && bun link
cd ../your-app && bun link phantombot
```

After changing anything under `src/engine/`, run `bun run build:engine-types`
and commit `types/engine/`. The test suite fails while the committed
declarations are stale.

## The root

`root` must be an absolute directory. It holds everything the engine owns:

| Path | Contents |
|---|---|
| `<root>/config/phantombot/config.toml` | root-wide settings (optional) |
| `<root>/data/phantombot/personas/<name>/` | persona files, `config.toml`, encrypted `vault.sqlite`, journal, KB |
| `<root>/data/phantombot/memory.sqlite` | turns, durable facts, drawers |
| `<root>/state/phantombot/` | engine lock, turn registry, digests |

- **It is exclusive.** A second engine on the same root, in this process or
  any other, fails with `root_locked` until the first one closes. Two writers
  on one memory database is how memory gets corrupted.
- **It is isolated from the host.** The engine never reads the host's
  `~/.config/phantombot` or `~/.local/share/phantombot`. It also ignores the
  host's location variables (`PHANTOMBOT_CONFIG`, `PHANTOMBOT_PERSONAS_DIR`,
  `PHANTOMBOT_MEMORY_DB`, `PHANTOMBOT_STATE`, …). Tuning variables such as
  timeouts still apply. Never point `root` at the host's own directories: the
  host daemon owns those.
- **Harness subprocesses inherit it.** They receive the root as `XDG_*`
  variables. A tool the model runs that calls `phantombot memory search`
  therefore reads the same memory.

## Trust: `source` is required

Every turn states who wrote the message. There is no default, because this is
the security boundary.

| `source` | Meaning | Screening |
|---|---|---|
| `"untrusted"` | Anything a third party can influence: your end users, email, web pages, webhooks | The threat judge scores it before any capable harness runs. At or above the threshold the turn is **held**: nothing runs, you get a `held` event, and the owner is notified on any channel the persona has. |
| `"principal"` | The persona's owner, speaking through code you control | Not screened |

Never pass end-user input as `"principal"`.

With `decisionModel.judge` enabled, the persona's decision model screens
untrusted input. If it is unavailable, screening falls back to the harness
judge, so it never goes dark.

## Tools: `"none"` by default

`tools` sets what the model can do during a turn:

- **`"none"`** (default). It thinks and answers, and cannot run commands, edit
  files or call MCP servers. Every harness enforces this.
- **`"full"`**. The persona's whole surface. Use it only with input you trust
  and a `workingDir` you are willing to let it change.
- **`{ allow: [...] }`**. A positive grant. Claude honours it. Pi and Codex
  ignore it, so it is defence in depth, not a boundary.

`workingDir` defaults to the persona's own directory, never `$HOME`.

## API

### `createEngine({ root, log? })`

Opens the engine. `log` is one of:

- `"stderr"` (default): JSON lines with secrets redacted, like the CLI.
- `"silent"`: drop them.
- A function that receives each parsed record.

The option also captures lines logged from abort listeners and subprocess
bookkeeping.

`engine.close()` cancels in-flight turns, waits for their harness process
groups to die, closes the database and releases the root. It is idempotent.
`await using engine = await createEngine(...)` works too.

### Personas

```ts
await engine.personas.list();                    // string[]
await engine.personas.exists("aria");            // boolean
await engine.personas.create("aria", { identity, tone, expertise, owner, hardRules });
const aria = engine.persona("aria");             // cheap handle; existence checked on use
```

### `persona.configure({ brain?, decisionModel? })`

`configure` writes to the persona's **own** `config.toml`, never the root-wide
file, so one persona's settings cannot leak into another's. Keys go to the
persona's **encrypted vault** and are never written to `config.toml` or
mirrored into `process.env`.

Only the fields you pass change. For optional models, `""` clears the value
and omitting it keeps the stored one.

```ts
await aria.configure({
  brain: {
    chain: ["native", "claude"],                 // fallback order
    native: { provider, model, coderModel?, visionModel?, apiKey? },
  },
  decisionModel: {
    provider?, model?, baseUrl?, keyName?, apiKey?,   // any decisions provider; see decide()
    judge?: boolean | { threshold?, timeoutMs? },  // screen untrusted turns
    router?: boolean | { timeoutMs? },             // pick primary vs coder per turn
  },
});
```

Other secret helpers: `persona.secrets.set(name, value)`, `.has(name)` and
`.delete(name)`.

### `persona.turn(options)` → `TurnStream`

```ts
interface TurnOptions {
  message: string;
  source: "untrusted" | "principal";
  conversation?: string;   // keeps history under "app:<key>"; omit for a stateless turn
  history?: boolean;       // default: true when conversation is set
  tools?: "none" | "full" | { allow: string[] };
  workingDir?: string;     // absolute; default the persona dir
  instructions?: string;   // appended to the system prompt for this turn
  signal?: AbortSignal;
}
```

A turn streams these `EngineEvent`s:

| Event | When |
|---|---|
| `{ type: "text", text }` | a delta of the reply, in order |
| `{ type: "tool", title, kind?, locations? }` | a tool call; only with tools enabled |
| `{ type: "status", note }` | progress, fallback or resume notes |
| `{ type: "held", message }` | **terminal**: the screen held the message |
| `{ type: "done", text, held: false }` | **terminal**: the reply |
| `{ type: "error", code, message }` | **terminal**: the turn failed |

How to consume a turn:

- Iterate the stream, call `result()`, or both. `result()` resolves with
  `{ text, held, conversation }` or rejects with an `EngineError`.
- A stream can be consumed once.
- Breaking out of the loop, calling `cancel()` or aborting `signal` kills the
  harness's process group. A cancelled turn rejects with `cancelled`.

`persona.ask(options)` is `turn(options).result()`.

### `persona.askJson({ ..., schema, jsonSchema?, retries? })`

`askJson` runs a turn whose answer must be JSON. Pass a validator in `schema`:
any [Standard Schema](https://standardschema.dev) (Zod 3.24+, Valibot,
ArkType), or a function that returns the value or throws. `jsonSchema` is shown
to the model so it knows the shape to produce; it is strongly recommended.

Replies can be bare JSON, a fenced block, or JSON embedded in prose.

When an answer is invalid, the engine retries and tells the model what was
wrong:

- **Default:** one retry with `tools: "none"`, **zero** otherwise. A retry
  re-runs the whole turn, and a turn with tools may already have had side
  effects.
- **Out of attempts:** rejects with `schema_invalid`.
- **Held message:** rejects with `held`.

Resolves `{ value, attempts, text, held, conversation }`.

### `persona.decide({ instructions, state, questions, timeoutMs? })`

`decide` sends typed questions to the persona's decision model. There is no
harness and no tools, and a call usually takes a few hundred milliseconds.

The decision model is a slot, not a vendor. TypeSafe Jev (`typesafe/jev-1.13`)
is the default today, reached through the built-in `openrouter` or `typesafe`
transports. Any service implementing the same decisions API can fill the slot.
Give it a provider name, its `baseUrl`, its `model` and the vault `keyName`
its key lives under:

```ts
await aria.configure({
  decisionModel: {
    provider: "acme",
    baseUrl: "https://decide.acme.example/v1",
    model: "acme/decider-2",
    keyName: "ACME_DECISIONS_KEY",
    apiKey,
  },
});
```

A custom provider without `baseUrl` is refused at `configure`. The engine never
guesses where to send a credential. Switching provider resets `model`,
`baseUrl` and `keyName` to the new provider's defaults unless you pass them
in the same call. Both rules are the ones `phantombot decision-model` follows.

```ts
const d = await aria.decide({
  instructions: "Triage support tickets.",
  state: ticketText,
  questions: {
    team: { type: "choice", instructions: "Which team?", criteria: { billing: "money", technical: "outages" } },
    urgency: { type: "score", instructions: "How urgent?", criteria: ["week", "day", "hours", "now"] },
  },
});
d.answers.team;    // { type: "choice", choice: "billing", probabilities, confidence }
d.answers.urgency; // { type: "score", score: 2.1, probabilities, confidence }
```

- A `choice` question allows at most 255 options.
- A `score` question allows at most 10 levels, lowest first. `score` is the
  expected level, from `0` to `levels - 1`.
- Failures reject with `not_configured` or `decision_unavailable`. The engine
  never guesses an answer.

### Memory

```ts
await aria.memory.capture("Deploys happen on Thursdays", { tags: ["norm"] });
await aria.memory.search("deploy day", { limit: 5, scope: "all" }); // MemoryHit[]
```

- `capture` indexes the note right away. The heartbeat later promotes tagged
  notes to drawers, as it does on the daemon.
- `search` uses the CLI's BM25F search, hybrid when embeddings are configured.

## Errors

Every public failure is an `EngineError` with a stable `code`:

| Code | Meaning |
|---|---|
| `invalid_root` | `root` is missing, relative, or cannot be created |
| `root_locked` | another engine owns this root |
| `engine_closed` | the engine was closed |
| `persona_not_found` | the persona is missing, or the name is invalid |
| `persona_exists` | `create` found the name taken |
| `invalid_argument` | a caller-supplied argument is invalid |
| `not_configured` | no harness, or no decision model |
| `harness_failed` | every harness in the chain failed |
| `cancelled` | the turn was cancelled |
| `schema_invalid` | structured output never validated |
| `held` | `askJson` on a held message |
| `decision_unavailable` | the decision model failed |
| `write_failed` | a config or vault write failed |

New codes may be added. An existing code is never repurposed.

## Conversations and privacy

Conversation keys are namespaced `app:<key>`, so they cannot collide with a
chat channel's history.

- **Turns are stamped `private`.** One end user's turns never surface in
  another user's conversation or in a Telegram group.
- **An app conversation is treated as multi-party.** The persona's private
  memories stay out of it, because your end users are third parties.

## Not included (yet)

- **Scheduled maintenance.** The engine does not drive the heartbeat or the
  nightly distillation. Captured notes and conversation turns are searchable
  immediately, but tagged notes are not promoted to drawers and days are not
  distilled. Do not point `phantombot heartbeat` at an engine root as a
  workaround: the heartbeat also heals the host's service units. Engine-driven
  maintenance is the next step.
- **`decide()` in doctor's decision-model telemetry.** The judge and the
  router still record their fallbacks, and `phantombot doctor` reports them.
  A failed `decide()` rejects to your application instead of falling back,
  and it is not recorded there.
- **Chat channels.** Telegram and PhantomChat stay in the daemon.
- **Node and Deno.**

## Secrets in `process.env`

`configure` and `secrets.set` never write to `process.env`. The harnesses,
however, read their key from the environment of the process they are spawned
from. Before each spawn the engine reconciles the persona's vault into
`process.env`, exactly as the daemon does, and removes those values again when
another persona's turn runs.

A variable your application already exported with the same name wins over the
vault.
