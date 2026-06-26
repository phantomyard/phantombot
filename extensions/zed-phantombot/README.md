# Phantombot for Zed

Route Zed's assistant through your Phantombot agent — same persona, memory, tools, and model routing as your Telegram/PhantomChat bot.

## Prerequisites

1. **Phantombot installed and on PATH** — `phantombot --version` should work
2. **At least one harness configured** — `phantombot harness` to set up
3. **Zed 0.135+** — context server support required

## Setup

### Option 1: Zed Settings (recommended for now)

Add to your Zed `settings.json` (`Cmd+,` → Open Settings (JSON)):

```json
{
  "context_servers": {
    "phantombot": {
      "command": "node",
      "args": ["/path/to/phantombot/extensions/zed-phantombot/server/index.js"],
      "settings": {}
    }
  }
}
```

Replace the path with your actual phantombot install location.

### Option 2: Zed Extension (when published)

1. Open Zed → Extensions panel
2. Search for "Phantombot"
3. Install

## Usage

Once configured, Phantombot tools appear in Zed's assistant panel:

- **`phantombot_ask`** — General questions through your agent. Full persona, memory, tools, and model routing.
- **`phantombot_explain`** — Explain selected code. Include file path and language for best results.
- **`phantombot_fix`** — Fix code issues. Include diagnostics (errors/warnings) for targeted fixes.
- **`phantombot_review`** — Code review for quality, bugs, security, and improvements.

### Using from the Assistant Panel

Open the Assistant Panel (`Cmd-?` or `Ctrl-?`) and type your message. Zed will route it through the Phantombot context server.

### Model Routing

The agent automatically picks the right model based on content:
- Screenshots/images → vision model
- Code edits → coding model
- Simple questions → fast model
- Architecture → reasoning model

You can also hint via the `modelHint` parameter.

## How It Works

```
Zed Assistant Panel
        │
        │  JSON-RPC (MCP protocol) over stdio
        ▼
Phantombot MCP Server (this extension)
        │
        │  child_process.spawn("phantombot", ["editor"])
        │  stdin: JSON context payload
        │  stdout: streaming response
        ▼
Phantombot CLI (trusted: true, full persona + tools)
```

## Architecture

- **MCP Server** (`server/index.js`) — bridges Zed's context server protocol to `phantombot editor`. Pure JavaScript, no build step.
- **CLI Backend** (`phantombot editor`) — the actual integration point. Reads JSON from stdin, streams response to stdout. Trusted by default (local invocation = same OS user).
- **Persona Engine** — SOUL.md, memory, tools, model routing. All the intelligence lives here.

## Development

### Testing the MCP server directly

```bash
# List tools
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node server/index.js

# Ask a question
echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"phantombot_ask","arguments":{"message":"hello"}}}' | node server/index.js
```

### Testing via phantombot editor directly

```bash
echo '{"message":"explain this function","activeFile":{"path":"src/app.ts","language":"typescript","content":"function add(a: number, b: number) { return a + b; }"}}' | phantombot editor
```

## Troubleshooting

**"Failed to spawn phantombot"** — phantombot is not on PATH or not installed. Run `which phantombot` to verify.

**Empty response** — Check `phantombot harness` to ensure at least one harness is configured.

**Slow first response** — The agent loads persona files and memory on first turn. Subsequent turns are faster.

## Future

- [ ] Zed-native extension (WASM) for proper marketplace distribution
- [ ] Inline chat integration (select code → "Ask Phantombot")
- [ ] Diagnostic-aware fixes (click error → "Fix with Phantombot")
- [ ] Screenshot/diagram attachment support via vision model routing
