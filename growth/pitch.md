# The De-enshitification Pitch: Why Phantombot?

## The Problem: The "Agentic" Bloat
Most AI agent platforms today have become "enshitified." They’ve moved away from the core utility and towards bloated abstractions, sluggish performance, and fragile tool-call parsing. 
- **The Deadlock:** You wait 10 seconds for an agent to "think" about whether it should run a bash command, only for it to fail because the JSON schema changed.
- **The Bloat:** 500MB+ Docker images just to send a Telegram message.
- **The Friction:** Permission gates that treat you like a stranger in your own terminal.

## The Solution: Phantombot
Phantombot is the "Spartan" answer to agentic bloat. It’s built on a single motivating insight: **The harness can do its own tools — let it.**

### 1. Minimalist & High-Torque
- **98MB Single Binary:** No runtime dependencies. No Node/Python/Docker required to run.
- **Atomic Updates:** Self-updates in under 2 seconds.
- **No Translation Layer:** We don't "translate" tool calls. We pass your intent to the best harnesses in the world (Pi, Claude Code, Gemini CLI) and let them use their native, highly-optimized tool loops.

### 2. Personality-First (The Soul)
Phantombot isn't just a wrapper; it's a **Soul**. It provides the identity, the memory, and the channel (Telegram), allowing you to interact with your agent as a peer, not a script.
- **Durable Memory:** A multi-layer memory system (SQLite for short-term, Markdown for long-term) that ensures your agent learns your business rules and preferences over time.
- **Voice-Native:** Seamless voice-in, voice-out support. It feels like a conversation, because it is one.

### 3. Privacy-First & Local
- **Local SQLite:** Your short-term memory stays on your disk.
- **No Cloud Middleware:** We don't proxy your data through a "managed" cloud. You own the binary, you own the keys.

## The Pitch: Stop Fighting Your Agents. Give Them a Soul.
Phantombot is for the power user who wants the power of Claude Code or Pi on the go, without the "managed" friction. It's fast, it's opinionated, and it just works.

**Join the de-enshitification movement.**
[GitHub: phantomyard/phantombot](https://github.com/phantomyard/phantombot)
