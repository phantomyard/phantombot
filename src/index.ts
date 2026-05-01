/**
 * Phantombot entry point.
 *
 * Boot order:
 *   1. Load config from env.
 *   2. Open the memory store.
 *   3. Build the harness chain from config.
 *   4. Build the channel adapters from config.
 *   5. Wire each channel's incoming handler through the orchestrator.
 *   6. Start every channel adapter.
 *   7. Wait for SIGINT/SIGTERM to shut down cleanly.
 *
 * Most of this is glue. The interesting code is in the harnesses (especially
 * src/harnesses/claude.ts) and the orchestrator (src/orchestrator/fallback.ts).
 */

import { loadConfig } from "./config.js";
import { log } from "./lib/logger.js";
import { openMemoryStore } from "./memory/store.js";
import { loadPersona } from "./persona/loader.js";
import { buildSystemPrompt } from "./persona/builder.js";
import { StaticRouter } from "./orchestrator/router.js";
import { runWithFallback } from "./orchestrator/fallback.js";
import { ClaudeHarness } from "./harnesses/claude.js";
import { CodexHarness } from "./harnesses/codex.js";
import { GeminiHarness } from "./harnesses/gemini.js";
import { PiHarness } from "./harnesses/pi.js";
import type { Harness } from "./harnesses/types.js";
import type { ChannelAdapter, IncomingMessage } from "./channels/types.js";
import { TelegramChannel } from "./channels/telegram.js";
import { SignalChannel } from "./channels/signal.js";
import { GoogleChatChannel } from "./channels/googlechat.js";

async function main(): Promise<void> {
  const config = loadConfig();
  log.info("phantombot starting", { agentDir: config.agentDir });

  const memory = await openMemoryStore(config.memoryDb);

  // Build the harness chain in the order specified in config.
  const allHarnesses: Record<string, Harness> = {
    claude: new ClaudeHarness({
      bin: config.harnesses.claude.bin,
      model: config.harnesses.claude.model,
      fallbackModel: config.harnesses.claude.fallbackModel,
    }),
    codex: new CodexHarness({
      bin: config.harnesses.codex.bin,
      model: config.harnesses.codex.model,
    }),
    gemini: new GeminiHarness({
      bin: config.harnesses.gemini.bin,
      model: config.harnesses.gemini.model,
    }),
    pi: new PiHarness({
      bin: config.harnesses.pi.bin,
      model: config.harnesses.pi.model,
    }),
  };
  const harnessChain: Harness[] = config.harnesses.chain
    .map((id) => allHarnesses[id])
    .filter((h): h is Harness => h !== undefined);
  log.info("harness chain configured", { ids: harnessChain.map((h) => h.id) });

  const router = new StaticRouter(config.agentDir, harnessChain);

  // Build channel adapters that have config; skip the rest.
  const channels: ChannelAdapter[] = [];
  if (config.channels.telegram) channels.push(new TelegramChannel(config.channels.telegram));
  if (config.channels.signal) channels.push(new SignalChannel(config.channels.signal));
  if (config.channels.googlechat) channels.push(new GoogleChatChannel(config.channels.googlechat));

  if (channels.length === 0) {
    log.warn("no channels configured — phantombot has nothing to listen on");
  }

  // Wire incoming messages through the orchestrator.
  const handle = async (msg: IncomingMessage): Promise<void> => {
    const decision = router.route(msg);
    const persona = await loadPersona(decision.agentDir);
    const recent = await memory.getRecentTurns(msg.conversationId, 20);

    const systemPrompt = buildSystemPrompt(
      persona,
      {
        channel: msg.conversationId.split(":")[0] ?? "unknown",
        conversationId: msg.conversationId,
        senderName: msg.senderName,
        timestamp: msg.timestamp,
      },
      undefined, // TODO: vector-search retrieval once memory store is implemented
    );

    let finalText = "";
    let errored: string | undefined;
    for await (const chunk of runWithFallback(decision.harnessChain, {
      systemPrompt,
      userMessage: msg.text,
      history: recent.map((t) => ({ role: t.role, text: t.text })),
      workingDir: decision.agentDir,
      timeoutMs: config.turnTimeoutMs,
    })) {
      switch (chunk.type) {
        case "text":
          finalText += chunk.text;
          break;
        case "progress":
          log.debug("harness progress", { note: chunk.note });
          break;
        case "done":
          finalText = chunk.finalText;
          break;
        case "error":
          errored = chunk.error;
          break;
      }
    }

    if (errored) {
      log.error("turn failed", { error: errored, conversationId: msg.conversationId });
      // Optionally surface a user-visible message. For now: silent fail.
      return;
    }

    await memory.appendTurn({
      conversationId: msg.conversationId,
      role: "user",
      text: msg.text,
      timestamp: msg.timestamp,
    });
    await memory.appendTurn({
      conversationId: msg.conversationId,
      role: "assistant",
      text: finalText,
      timestamp: new Date(),
    });

    // Find the channel adapter that owns this conversation and send the reply.
    const channelId = msg.conversationId.split(":")[0];
    const channel = channels.find((c) => c.id === channelId);
    if (!channel) {
      log.error("no channel adapter for incoming message", { channelId });
      return;
    }
    await channel.send({ conversationId: msg.conversationId, text: finalText });
  };

  for (const channel of channels) {
    channel.start(handle).catch((err) => {
      log.error("channel start failed", { id: channel.id, error: String(err) });
    });
  }

  log.info("phantombot ready");

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info("shutting down", { signal });
    for (const channel of channels) {
      try {
        await channel.stop();
      } catch (err) {
        log.warn("channel stop error", { id: channel.id, error: String(err) });
      }
    }
    await memory.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error("fatal", { error: String(err), stack: (err as Error).stack });
  process.exit(1);
});
