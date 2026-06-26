---
type: design
tags: [phantombot, vscode, zed, extension, llm-routing]
created: 2026-06-26
status: draft
---

# Phantombot Editor Extension — Design Document

## Problem

AI coding assistants (Copilot, Cursor, Claude Code) are stateless per-session. They don't remember past decisions, can't run tools, can't follow your conventions, and force you into a single model's capabilities. When you need vision for a screenshot or a different model for a refactor, you either lose context or spawn a separate agent.

Phantombot already has: persistent memory, persona-driven behavior, multi-model routing, and full tool access. The missing piece is a surface that connects this to editors.

## Goal

A VS Code and Zed extension that makes Phantombot a first-class AI coding assistant — replacing Claude/Pi as the in-editor AI while inheriting all of Phantombot's capabilities.

## Core Differentiators

### 1. Persistent Memory Across Sessions
- The agent remembers past coding sessions, architectural decisions, and bugs
- No "context window amnesia" — compressed context augmented with relevant memories
- Auto-capture: coding decisions and lessons feed back into the knowledge base

### 2. Persona Continuity
- Same persona (Kai/Lena/Robbie) across Telegram and editor
- SOUL.md conventions apply everywhere
- One identity, not a separate "editor agent"

### 3. LLM-Agnostic Model Routing
- One conversation thread, multiple models under the hood
- Automatic model switching based on content, not manual selection
- No subagent split — same context, same memory, same tools

### 4. Full Tool Access
- Bash, file ops, GitHub, memory search — all available during coding
- Agent can actually run tests, search files, check git — not just suggest text
- Capture coding lessons into the knowledge base automatically

## Architecture: CLI-Native

No HTTP endpoint. No new server surface. The extension is a thin client that shells out to `phantombot`.

```
Editor Extension (VS Code / Zed)
        │
        │  child_process.spawn("phantombot", ["editor", ...])
        │  stdin: JSON context payload
        │  stdout: streaming response chunks
        ▼
Phantombot CLI (`phantombot editor`)
        │
        │  trusted: true (local invocation = same OS user = principal)
        │  No threat judge — skips the screener entirely
        ▼
Persona Engine (SOUL.md, memory, tools, model routing)
        │
        ▼
Response streamed back to editor
```

### Why CLI, not HTTP

- No new server to start, secure, or manage
- phantombot must already be installed — extension is a thin client
- Same binary, same config, same persona — zero new infra
- Works offline (local model routing) with no port conflicts
- Extension installs via marketplace, discovers `phantombot` on PATH

### Trust Model: Local CLI = Trusted

The threat judge screens **external, untrusted input** — email pollers, webhooks, Telegram messages from non-allowlisted users. A local CLI command from the editor is already authenticated by OS-level user permissions:

- Same OS user running the editor = same user running phantombot
- Filesystem access is already granted (extension reads/writes the same workspace)
- No privilege escalation possible — the user already has full access to phantombot's data

**Implementation:** New `phantombot editor` subcommand that sets `trusted: true` internally and runs through the full persona/memory/tool chain without the screener. This is NOT a `--trusted` flag on `phantombot ask` (that would be a perimeter bypass) — it's a separate command with a clear, auditable trust boundary.

**Guardrails:**
- `phantombot editor` only accepts input on stdin (never argv) to prevent shell injection
- Context payload is validated/typed (not raw text passthrough)
- Conversation history scoped to workspace (`editor:<workspace-hash>`)
- Same hard/idle timeouts as `ask`

## CLI Command: `phantombot editor`

```bash
# One-shot (stateless)
echo '{"message":"explain this function","activeFile":{"path":"src/foo.ts","language":"typescript","content":"..."}}' \
  | phantombot editor

# Multi-turn (threaded by workspace)
echo '{"message":"now fix the bug","activeFile":{...}}' \
  | phantombot editor --history --conversation "editor:/path/to/workspace"

# Streaming (default for editor integration)
echo '{"message":"refactor this","activeFile":{...}}' \
  | phantombot editor --stream
```

### Stdin Payload

```typescript
interface EditorPayload {
  /** The user's message. Required. */
  message: string;

  /** Active file context. */
  activeFile?: {
    path: string;
    language: string;
    content: string;
    selection?: { startLine: number; endLine: number; text: string };
  };

  /** Workspace info. */
  workspace?: {
    root: string;
    openFiles: string[];
  };

  /** Diagnostics (errors/warnings) from the editor. */
  diagnostics?: Array<{
    path: string;
    line: number;
    column: number;
    message: string;
    severity: "error" | "warning" | "info";
  }>;

  /** Attached images (screenshots, diagrams). Base64-encoded. */
  images?: Array<{
    mime: string;       // "image/png", "image/jpeg"
    data: string;       // base64-encoded
  }>;

  /** Attached files (dragged into chat). */
  attachedFiles?: Array<{
    path: string;
    content: string;
  }>;

  /** Model routing hint. Backend decides, but editor can suggest. */
  modelHint?: "vision" | "code" | "fast" | "reasoning";

  /** For multi-turn: conversation ID (auto-generated if omitted). */
  conversationId?: string;
}
```

### Stdin Payload (non-streaming, shell-compatible)

For backward compatibility with shell pipes, non-streaming mode returns final text only:

```bash
echo '{"message":"explain this"}' | phantombot editor --no-stream
# stdout: plain text response
```

### Stdout: Streaming Output

Newline-delimited JSON chunks:

```
{"type":"text","content":"Here's the refactored version..."}
{"type":"tool_use","tool":"bash","command":"npm test"}
{"type":"tool_result","output":"All tests passed"}
{"type":"text","content":"Tests pass. Here's what I changed..."}
{"type":"done","model":"claude-sonnet-4"}
```

## Model Routing — The Key Innovation

Single conversation thread, multi-model backend. The editor doesn't know or care which model is running.

### How It Works

1. **Automatic detection, not manual switching.** Paste a screenshot into the same chat where you were discussing code. Phantombot sees the image, routes to a vision model for that turn, then routes back to the coding model. Same thread, same memory, same persona.

2. **Model config is in the persona, not the editor.**
   ```
   # MODELS.md (per-persona)
   primary: claude-sonnet-4      # default: speed + personality
   vision: gpt-4o                # when message contains images
   code: claude-opus-4           # heavy refactors, multi-file edits
   fast: claude-haiku            # simple questions, explanations
   reasoning: o3                 # complex architectural decisions
   ```
   Change models without touching the editor. Swapping `claude-sonnet-4` for `gemini-2.5-pro` is a one-line config change.

3. **Context window management is the backend's job.** When switching from a 200k to 128k context model, Phantombot handles truncation/compression transparently. Compressed context gets augmented with relevant memories.

4. **No subagent split.** One agent — same persona, same memory, same tools — just different inferencing hardware for different turns. The model is a runtime detail, not an identity boundary.

### Routing Rules

```yaml
# MODELS.md — routing configuration
routing:
  default: primary

  rules:
    - match: message contains images
      route: vision
    - match: message length < 50 tokens AND no code context
      route: fast
    - match: file edits > 3 OR multi-file refactor
      route: code
    - match: message contains "think step by step" OR architectural discussion
      route: reasoning

  hints:
    vision: vision
    code: code
    fast: fast
    reasoning: reasoning

  fallback:
    - primary
    - fast
```

## VS Code Extension — Design

### Chat Participant API (stable since 1.89)

Register a `@phantombot` chat participant in VS Code's Chat view.

```typescript
// src/extension.ts
import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
  const participant = vscode.chat.createChatParticipant(
    'phantombot',
    handleChatRequest
  );
  participant.followupProvider = { provideFollowups };

  context.subscriptions.push(participant);
}

async function handleChatRequest(
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
  // 1. Build context payload
  const payload = buildPayload(request, chatContext);

  // 2. Spawn phantombot editor
  const phantombotPath = resolvePhantombot();
  const proc = spawn(phantombotPath, ['editor', '--stream'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // 3. Send payload on stdin
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();

  // 4. Stream response back to VS Code
  proc.stdout.on('data', (chunk: Buffer) => {
    const lines = chunk.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'text') {
          stream.markdown(parsed.content);
        } else if (parsed.type === 'tool_use') {
          stream.progress(`Running ${parsed.tool}...`);
        }
      } catch { /* skip malformed lines */ }
    }
  });

  return {};
}
```

### Context Payload Builder

```typescript
function buildPayload(
  request: vscode.ChatRequest,
  context: vscode.ChatContext
): EditorPayload {
  const editor = vscode.window.activeTextEditor;
  const doc = editor?.document;

  return {
    message: request.prompt,
    modelHint: detectHint(request),
    activeFile: doc ? {
      path: doc.uri.fsPath,
      language: doc.languageId,
      content: doc.getText(),
      selection: editor.selection.isEmpty ? undefined : {
        startLine: editor.selection.start.line,
        endLine: editor.selection.end.line,
        text: doc.getText(editor.selection),
      },
    } : undefined,
    workspace: vscode.workspace.workspaceFolders?.[0] ? {
      root: vscode.workspace.workspaceFolders[0].uri.fsPath,
      openFiles: vscode.window.visibleTextEditors.map(
        e => e.document.uri.fsPath
      ),
    } : undefined,
    diagnostics: doc ? vscode.languages.getDiagnostics(doc.uri).map(d => ({
      path: doc.uri.fsPath,
      line: d.range.start.line,
      column: d.range.start.character,
      message: d.message,
      severity: d.severity === vscode.DiagnosticSeverity.Error ? "error" as const
        : d.severity === vscode.DiagnosticSeverity.Warning ? "warning" as const
        : "info" as const,
    })) : undefined,
    conversationId: request.references?.find(r => r.id === 'conversationId')?.value as string,
  };
}

function resolvePhantombot(): string {
  const config = vscode.workspace.getConfiguration('phantombot');
  return config.get<string>('path', 'phantombot');
}
```

### Rich Features

- **Code actions:** Right-click → "Ask Phantombot about this"
- **Diagnostics integration:** Click diagnostic → "Fix with Phantombot"
- **Inline chat (Cmd+I):** Select code, press Cmd+I, ask a question with selection as context
- **Terminal integration:** `/phantombot` command in integrated terminal
- **File tree context:** Right-click files/folders → "Add to Phantombot context"

### Extension Settings

```json
{
  "phantombot.path": "phantombot",
  "phantombot.persona": "kai",
  "phantombot.autoContext": true,
  "phantombot.maxContextFiles": 10,
  "phantombot.conversationPersistence": true
}
```

## Zed Extension — Design

Zed's assistant panel supports custom providers. Simpler API but less mature.

### Same CLI Backend

Same `phantombot editor` CLI — same payload, same output format. Zed-specific UX adaptation for the panel.

### Extension Manifest

```json
{
  "name": "phantombot",
  "version": "0.1.0",
  "description": "Phantombot AI assistant for Zed",
  "zed_api_version": "0.2.0",
  "assistant_provider": {
    "name": "Phantombot",
    "model": "phantombot"
  }
}
```

The provider spawns `phantombot editor --stream` with the same stdin/stdout protocol. Zed provides active file, selection, language, and workspace root — same fields as VS Code.

## Configuration

### MODELS.md (Per-Persona)

```markdown
---
type: models
persona: kai
---

# Model Configuration

## Routing
primary: claude-sonnet-4
vision: gpt-4o
code: claude-opus-4
fast: claude-haiku
reasoning: o3

## Rules
- Images → vision
- Code edits > 3 files → code
- Simple questions → fast
- Architectural decisions → reasoning

## Context Management
max_history: 50
compress_threshold: 0.8
memory_augmentation: true
```

## Security Considerations

### Trust Boundary

The `phantombot editor` command is a **separate trust boundary** from `phantombot ask`. Key design decisions:

1. **Separate command, not a flag.** Adding `--trusted` to `ask` would create a bypass path that could be misused. A dedicated `editor` command is auditable and clear.

2. **Stdin-only.** The payload is passed via stdin, never argv. This prevents shell injection, handles large file contents cleanly, and avoids leaking context in process listings.

3. **Typed validation.** The JSON payload is validated against the `EditorPayload` schema. Malformed input is rejected before reaching the persona engine.

4. **No remote invocation.** The command doesn't listen on any port. It can only be invoked by a local process — same OS user, same machine.

### Threat Model

| Threat | Mitigation |
|--------|-----------|
| Malicious extension sends bad prompts | Same OS user — already has full access to phantombot data. No privilege escalation possible. |
| Shell injection via argv | Stdin-only input. No argv passthrough. |
| Prompt injection via file contents | Handled by existing threat judge for untrusted content within the persona engine (file contents are not "trusted" even though the invocation is). |
| Resource exhaustion | Same hard/idle timeouts as `ask`. Workspace-scoped conversation limits. |
| Eavesdropping on output | No network involved. Local process pipes only. |

### CLI Security Policy Changes

The existing security policy may need a small addition: allowlist the `editor` subcommand as inherently trusted when invoked locally. This is simpler than creating a full permission model — the command name IS the permission.

```typescript
// In the CLI dispatcher
if (subcommand === 'editor') {
  // Local editor invocation — same OS user = principal.
  // Skip threat judge, proceed with full tool access.
  context.trusted = true;
}
```

## Implementation Plan

### Phase 1 — CLI Command + VS Code MVP (2-3 weeks)

- [ ] New `phantombot editor` CLI command
  - stdin JSON payload, streaming stdout (newline-delimited JSON)
  - Trust boundary: `trusted: true`, skip screener
  - Payload validation and typed interface (`EditorPayload`)
  - Non-streaming mode for shell compatibility
- [ ] VS Code extension: `@phantombot` chat participant
  - Auto-discover `phantombot` binary (PATH, config, common locations)
  - Context injection: active file, selection, diagnostics, workspace
  - Streaming response rendering
  - Follow-up questions support
- [ ] Tests: CLI parsing, payload validation, streaming, trust boundary

### Phase 2 — Model Routing + Multi-Turn (1-2 weeks)

- [ ] `MODELS.md` config for persona-level model definitions
- [ ] Content-based automatic model selection (image → vision, code → coding model)
- [ ] Context window management across model switches
- [ ] Conversation persistence by workspace
- [ ] Memory integration: auto-capture coding decisions, search past sessions
- [ ] Tests: routing logic, context compression, memory capture

### Phase 3 — Zed Support (1-2 weeks)

- [ ] Zed assistant provider using same `phantombot editor` CLI
- [ ] Same payload structure, same backend
- [ ] Platform-specific UX adaptation

### Phase 4 — Advanced (ongoing)

- [ ] Inline chat (Cmd+I) support
- [ ] Code action integration (right-click → "Ask Phantombot")
- [ ] Image/screenshot attachment support
- [ ] Multi-file edit orchestration
- [ ] Terminal command execution with confirmation
- [ ] Workspace-wide context (git history, project structure)
- [ ] Auto-capture coding lessons to memory/knowledge base

## Design Principles

1. **CLI-native.** No HTTP endpoint. Extension spawns `phantombot editor` via `child_process`.
2. **Local trust.** Local CLI invocation = same OS user = principal. Threat judge skipped. This is a separate command, not a flag on `ask`.
3. **Stdin-only input.** Never argv — prevents shell injection and handles large payloads cleanly.
4. **Streaming by default.** Newline-delimited JSON on stdout. Non-streaming for shell compatibility.
5. **Extension is dumb.** All intelligence (memory, tools, persona, model routing) lives in the phantombot binary. Extension is a context-gathering I/O surface.
6. **Binary discovery.** Extension finds `phantombot` on PATH or via config. No bundled binary.
7. **Workspace-scoped conversations.** Conversation ID auto-derived from workspace path. Same workspace = same thread.
8. **No new infra.** Zero daemons, zero ports, zero TLS. Just a CLI command.
9. **Persona-first.** Same persona (Kai/Lena/Robbie) across Telegram and editor. SOUL.md conventions apply everywhere.
10. **Model routing is backend-owned.** Editor sends hints, backend decides. Config in `MODELS.md`, not extension settings.

## Open Questions

1. **Installation:** How does phantombot get installed? The extension should detect a missing binary and guide installation.
2. **Multi-workspace:** VS Code multi-root workspaces — which workspace root scopes the conversation?
3. **Image pasting:** VS Code chat doesn't natively support image paste yet. May need a custom input mechanism or drag-and-drop.
4. **Extension marketplace:** Publish to VS Code marketplace and Zed's extension store? Or sideload only?
5. **Pricing:** Free extension, paid backend? Or fully self-hosted and free?

---

*Created: 2026-06-26 by Kai*
*Updated: 2026-06-26 — Rewritten for CLI-native architecture (issue #199)*
*Status: Draft — needs review from Andrew and team*
