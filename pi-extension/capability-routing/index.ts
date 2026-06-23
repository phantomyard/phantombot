/**
 * Capability-routing Pi extension (phantombot).
 *
 * Lets a strong-but-narrow PRIMARY Pi model delegate specialist subtasks
 * within a single turn:
 *
 *   look_at_image(path, question) — spawns the IMAGE model to answer a
 *       specific question about an image. Registered ONLY when the primary is
 *       NOT multimodal (the wizard records an `imageModel` in routing.json only
 *       then; for a multimodal primary the key is absent and this tool never
 *       appears — the primary looks at the image itself).
 *
 *   coder(task) — spawns the CODING model as a fresh `pi` process with
 *       edit,bash,write for a PR/MR-scoped job or review. Coarse-grained:
 *       process startup is expensive, so each call should be a big chunk, not
 *       a chatty round-trip. Usage/cost is surfaced back to the parent.
 *
 * This is capability routing WITHIN a turn — orthogonal to phantombot's
 * primary→fallback harness chain (failover), which this extension does not
 * touch.
 *
 * Reads its config from a managed sibling data file `routing.json` in this
 * extension's own directory (see ./tools.ts for the shape). The extension
 * needs zero knowledge of phantombot's config files or env vars.
 *
 * MANAGED SOURCE: this directory is OWNED by phantombot — it is stamped into
 * ~/.pi/agent/extensions/capability-routing/ on every phantombot startup (and
 * repaired by `phantombot doctor`), overwriting any local edits. To change the
 * extension, edit pi-extension/capability-routing/ in the phantombot repo and
 * regenerate the embedded assets (`bun run gen:pi-extension`). A manual symlink
 * (see ./README.md) is only for extension development.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  coderDelegationPrompt,
  imageDelegationPrompt,
  planRouting,
  type RoutingConfig,
} from "./tools.ts";
import {
  delegate,
  finalText,
  formatProgressLines,
  ProgressBatcher,
  usageLine,
  type DelegateProgress,
} from "./spawnPi.ts";

/** Flush the buffer after this much idle time since the last event. */
const PROGRESS_IDLE_FLUSH_MS = 5_000;
/** Flush early once the buffer reaches this many lines, whichever comes first. */
const PROGRESS_MAX_LINES = 10;

/**
 * Read the persistent `/viewcoder` override for this conversation, if any.
 *
 * The extension is dependency-free and cannot import phantombot's
 * src/lib/viewCoder.ts, so it re-derives that store's path + JSON shape inline.
 * Keep these in sync with src/lib/viewCoder.ts:
 *   - path: $PHANTOMBOT_VIEW_CODER_STATE, else
 *           ${XDG_STATE_HOME | ~/.local/state}/phantombot/view-coder-overrides.json
 *   - key:  `${persona}\u0000${conversation}`
 *   - entry: { mode: "on" | "off", touchedAt }
 *
 * Returns "on" | "off" when an override exists, else undefined (defer to the
 * routing default). Any error (no env, missing/garbled file) ⇒ undefined.
 */
function viewCoderOverrideOf(): "on" | "off" | undefined {
  const persona = process.env.PHANTOMBOT_PERSONA;
  const conversation = process.env.PHANTOMBOT_CONVERSATION;
  if (!persona || !conversation) return undefined;
  const statePath =
    process.env.PHANTOMBOT_VIEW_CODER_STATE ||
    path.join(
      process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
      "phantombot",
      "view-coder-overrides.json",
    );
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<
      string,
      { mode?: unknown }
    >;
    const entry = parsed[`${persona}\u0000${conversation}`];
    const mode = entry?.mode;
    return mode === "on" || mode === "off" ? mode : undefined;
  } catch {
    return undefined;
  }
}

interface CoderProgressSink {
  onProgress: (ev: DelegateProgress) => void;
  onProgressEnd: () => void;
}

/**
 * Build an ACCUMULATING progress sink that forwards the coder child's per-turn
 * events to the user via `phantombot notify`. Returns undefined when streaming
 * is off globally, so the delegate runs in its original silent mode.
 *
 * Channel-agnostic by construction: the sink only shells out to `phantombot
 * notify`, which fans the message out to the first owner of EVERY configured
 * channel for the persona (Telegram + phantomchat today, any future channel as
 * `notify` grows). This extension deliberately knows nothing about channels —
 * it never touches Telegram (or any other channel) code directly, so progress
 * automatically reaches whatever channels the persona has, not just Telegram.
 *
 * Design notes:
 *  - Per-conversation override: the persistent `/viewcoder` choice for this
 *    conversation wins over the global default, re-read at EMIT time so a mid-
 *    job toggle takes effect. `off` suppresses streaming; `on` forces it even
 *    when the global default is off.
 *  - Hybrid batching (Option C): lines accumulate into a buffer and flush as
 *    ONE digest notify when EITHER the coder has been idle ~5s OR the buffer
 *    reaches ~10 lines — whichever comes first. The `finally`-driven
 *    onProgressEnd drains the tail so nothing is lost at the end.
 *  - Fire-and-forget: each flush is a detached `phantombot notify`; we never
 *    await it and swallow every error. Progress must never slow down or break
 *    the actual coding job.
 *  - Skips terminal turns: that text is the final answer, which the parent
 *    model already receives as the tool result — no need to double-report it.
 *
 * `globalDefault` is the routing.json `codingProgress` flag. Streaming for THIS
 * job is on when: override === "on", OR (override === undefined AND
 * globalDefault). override === "off" always wins (silent).
 */
function makeCoderProgressSink(
  globalDefault: boolean,
): CoderProgressSink {
  // Always built; gated per emit. An `on` /viewcoder override must be able to
  // force streaming even when globalDefault is off, and overrides can change
  // mid-job, so the on/off decision is deferred to streamingEnabled() at each
  // event rather than baked in here. The cost of an inert (suppressed) sink is
  // negligible — it just never adds to the batcher and never flushes.
  const streamingEnabled = (): boolean => {
    const override = viewCoderOverrideOf();
    if (override === "on") return true;
    if (override === "off") return false;
    return globalDefault;
  };

  // One detached, fire-and-forget `phantombot notify` per flushed digest.
  // Channel-agnostic: notify fans out to every configured channel. No prefix —
  // the body is pure narration so it reads like the primary persona talking.
  const emit = (lines: string): void => {
    const body = lines;
    try {
      const child = spawn("phantombot", ["notify", "--message", body], {
        stdio: "ignore",
        detached: true,
      });
      child.on("error", () => {});
      child.unref();
    } catch {
      /* notify is best-effort; never let it affect the delegation */
    }
  };

  const batcher = new ProgressBatcher({
    maxLines: PROGRESS_MAX_LINES,
    idleMs: PROGRESS_IDLE_FLUSH_MS,
    emit,
  });

  const onProgress = (ev: DelegateProgress): void => {
    if (ev.terminal) return;
    if (!streamingEnabled()) return;
    batcher.add(formatProgressLines(ev));
  };

  const onProgressEnd = (): void => {
    // Drain whatever's left so the tail is never lost.
    batcher.drain();
  };

  return { onProgress, onProgressEnd };
}

/**
 * Resolve this extension's own directory robustly across runtimes, then read
 * and parse the managed `routing.json` sibling. On ANY error (file missing,
 * unreadable, or invalid JSON) we default to `{}` — which registers no tools,
 * the safe inert state.
 */
function loadRoutingConfig(): RoutingConfig {
  let dir: string | undefined;
  // Bun exposes the module dir directly.
  const bunDir = (import.meta as { dir?: string }).dir;
  if (typeof bunDir === "string" && bunDir.length > 0) {
    dir = bunDir;
  } else {
    try {
      dir = path.dirname(new URL(import.meta.url).pathname);
    } catch {
      dir = undefined;
    }
  }
  if (!dir) return {};
  try {
    const raw = fs.readFileSync(path.join(dir, "routing.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as RoutingConfig) : {};
  } catch {
    return {};
  }
}

const LookAtImageParams = Type.Object({
  path: Type.String({ description: "Absolute path to the image file to inspect." }),
  question: Type.String({
    description: "The specific question to answer about the image (question-driven, not a one-shot describe).",
  }),
});

const CoderParams = Type.Object({
  task: Type.String({
    description:
      "A PR/MR-scoped coding task or review. Coarse-grained — each call spawns a fresh, expensive process, so send a big self-contained chunk, not a quick question.",
  }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the coding agent." })),
});

export default function (pi: ExtensionAPI) {
  const plan = planRouting(loadRoutingConfig());

  if (plan.registerLookAtImage && plan.imageModel) {
    const imageModel = plan.imageModel;
    pi.registerTool({
      name: "look_at_image",
      label: "Look at image",
      description: [
        "Delegate a vision question to a multimodal image model and get the answer.",
        "Use this when you (the primary model) cannot see images yourself.",
        "Ask a specific question — this is question-driven, not a blind describe.",
      ].join(" "),
      parameters: LookAtImageParams,
      async execute(_id, params, signal) {
        const r = await delegate({
          model: imageModel,
          task: imageDelegationPrompt(params.path, params.question),
          // Vision Q&A doesn't need edit/bash/write; keep it tool-light.
          tools: ["read"],
          signal,
        });
        if (r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted") {
          return {
            content: [
              {
                type: "text",
                text: `look_at_image failed (${r.stopReason ?? `exit ${r.exitCode}`}): ${
                  r.errorMessage || r.stderr || "no output"
                }`,
              },
            ],
            details: { model: imageModel, usage: r.usage },
            isError: true,
          };
        }
        const answer = finalText(r.messages) || "(no answer)";
        return {
          content: [{ type: "text", text: `${answer}\n\n[image model: ${usageLine(r)}]` }],
          details: { model: imageModel, usage: r.usage },
        };
      },
    });
  }

  if (plan.registerCoder && plan.codingModel) {
    const codingModel = plan.codingModel;
    pi.registerTool({
      name: "coder",
      label: "Coder",
      description: [
        "Delegate a PR/MR-scoped coding job or review to a coding-specialist model.",
        "Coarse-grained: spawns a fresh pi process (edit,bash,write) with an isolated context.",
        "Expensive startup — use for big self-contained chunks, not chatty calls.",
      ].join(" "),
      parameters: CoderParams,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const cwd = params.cwd ?? ctx.cwd;
        // Build the streaming sink unconditionally so an `on` /viewcoder
        // override can force progress even when the global default is off; the
        // sink gates per emit. plan.streamCoderProgress is the global default.
        const sink = makeCoderProgressSink(plan.streamCoderProgress);
        const r = await delegate({
          model: codingModel,
          task: coderDelegationPrompt(params.task),
          tools: ["edit", "bash", "write"],
          cwd,
          signal,
          onProgress: sink.onProgress,
          onProgressEnd: sink.onProgressEnd,
        });
        if (r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted") {
          return {
            content: [
              {
                type: "text",
                text: `coder failed (${r.stopReason ?? `exit ${r.exitCode}`}): ${
                  r.errorMessage || r.stderr || "no output"
                }`,
              },
            ],
            details: { model: codingModel, usage: r.usage },
            isError: true,
          };
        }
        const out = finalText(r.messages) || "(no output)";
        return {
          content: [{ type: "text", text: `${out}\n\n[coding model: ${usageLine(r)}]` }],
          details: { model: codingModel, usage: r.usage },
        };
      },
    });
  }
}
