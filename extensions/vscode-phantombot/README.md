# Phantombot for VS Code

Route VS Code's assistant through your Phantombot agent — same persona, memory, tools, and model routing as your Telegram/PhantomChat bot.

## Features

- **`@phantombot` chat participant** — type `@phantombot` in the Chat view to talk to your agent
- **Persistent memory** — the agent remembers past coding sessions, architectural decisions, and bugs
- **Full tool access** — bash, file ops, GitHub, memory search — all available during coding
- **LLM-agnostic model routing** — screenshot a bug → vision model → code model fixes it → fast model for follow-up. Same thread, same context.
- **Auto context** — active file, selection, and diagnostics are included automatically
- **Persona continuity** — same persona (Kai/Lena/Robbie) across Telegram and VS Code

## Prerequisites

1. **Phantombot installed and on PATH** — `phantombot --version` should work
2. **At least one harness configured** — `phantombot harness` to set up
3. **VS Code 1.89+** — Chat Participant API required

## Installation

### From source (development)

```bash
cd extensions/vscode-phantombot
npm install
npm run compile
# Then: Run Extension from VS Code debug panel (F5)
```

### From marketplace (when published)

1. Open VS Code
2. Extensions panel → Search "Phantombot"
3. Install

## Usage

### Chat View

1. Open the Chat view (`Cmd+Shift+I` or `Ctrl+Shift+I`)
2. Type `@phantombot` followed by your message
3. The agent responds with full persona, memory, and tool access

### Slash Commands

- `/code <message>` — hint to use the coding model
- `/vision <message>` — hint to use the vision model (for screenshots)
- `/fast <message>` — hint to use the fast model (simple questions)
- `/reason <message>` — hint to use the reasoning model (architecture)

### Context Injection

When `phantombot.autoContext` is enabled (default), the extension automatically includes:

- **Active file** — the file you're editing, with language and content
- **Selection** — if you have code selected
- **Diagnostics** — errors and warnings from the Problems panel
- **Open files** — up to 10 visible editor tabs
- **Workspace root** — so the agent can run tests, check git, etc.

### Commands

- **Phantombot: Select Persona** — switch persona from the Command Palette
- **Phantombot: Check Status** — verify phantombot is installed and responding

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `phantombot.persona` | `""` | Persona override (empty = default) |
| `phantombot.path` | `"phantombot"` | Path to the phantombot binary |
| `phantombot.autoContext` | `true` | Auto-include active file context |
| `phantombot.maxContextFiles` | `10` | Max open files in workspace context |
| `phantombot.conversationPersistence` | `true` | Persist conversation across sessions |

## How It Works

```
VS Code Chat (@phantombot)
        │
        │  child_process.spawn("phantombot", ["editor"])
        │  stdin: JSON context payload
        │  stdout: streaming response chunks
        ▼
Phantombot CLI (trusted: true, full persona + tools)
        │
        ▼
Persona Engine (SOUL.md, memory, tools, model routing)
```

The extension is a thin context-gathering surface. All intelligence lives in the phantombot binary — same persona, same memory, same tools as your Telegram bot.

## Model Routing

The agent automatically picks the right model based on content:

| Content | Model | Why |
|---------|-------|-----|
| Screenshots/images | Vision | Multimodal understanding |
| Code edits/refactors | Code | Deep code comprehension |
| Simple questions | Fast | Speed over depth |
| Architecture/design | Reasoning | Complex analysis |

Change models without touching VS Code — edit `MODELS.md` in your persona directory.

## Development

### Build

```bash
npm install
npm run compile
```

### Watch mode

```bash
npm run watch
```

### Debug

1. Open this folder in VS Code
2. Press F5 (Run Extension)
3. A new VS Code window opens with the extension loaded
4. Open Chat and type `@phantombot hello`

## Troubleshooting

**"Phantombot not found"** — phantombot is not on PATH. Run `which phantombot` to verify, or set `phantombot.path` in settings.

**Empty response** — Run `phantombot harness` to ensure at least one harness is configured.

**Slow first response** — The agent loads persona files and memory on first turn. Subsequent turns are faster.

**No context included** — Check that `phantombot.autoContext` is enabled in settings.

## Future

- [ ] Inline chat integration (`Cmd+I` → Ask Phantombot)
- [ ] Code action: right-click → "Ask Phantombot about this"
- [ ] Diagnostic integration: click error → "Fix with Phantombot"
- [ ] File tree context: right-click files/folders → "Add to context"
- [ ] Screenshot/diagram attachment support
- [ ] Multi-file edit orchestration
