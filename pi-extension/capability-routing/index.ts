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
  delegateFailureText,
  finalText,
  isDelegateFailure,
  formatProgressLines,
  notifyArgs,
  ProgressBatcher,
  usageLine,
  type DelegateProgress,
} from "./spawnPi.ts";

/** Flush the buffer after this much idle time since the last event. */
const PROGRESS_IDLE_FLUSH_MS = 5_000;
/** Flush early once the buffer reaches this many lines, whichever comes first. */
const PROGRESS_MAX_LINES = 10;

/**
 * Idle bound for a delegate child (ms): if it produces NO output for this long
 * it's treated as wedged, killed, and returned to the primary as a tested
 * failure (see spawnPi.ts DelegateOptions.idleTimeoutMs).
 *
 * MUST sit comfortably under phantombot's PRIMARY idle watchdog (default 300s),
 * so a wedged delegate returns a tool result BEFORE the primary's own watchdog
 * trips and kills the whole turn — which would (wrongly) look like a primary
 * failure and trigger a harness fallback. 240s leaves ~60s of headroom for the
 * tool to return, the primary to emit its next turn, and iterate.
 */
const DELEGATE_IDLE_TIMEOUT_MS = 240_000;

/**
 * The active harness's Pi provider + api-key, relayed from the parent pi via
 * env (PHANTOMBOT_PI_PROVIDER / PHANTOMBOT_PI_API_KEY). The parent harness sets
 * these into THIS process's environment when it spawns us, scoped to whichever
 * pi harness is running this turn — so a box with a primary Pi→OpenRouter and a
 * fallback Pi→OpenAI never collides two providers in one namespace: each pi
 * subtree carries exactly its own pair. We thread them onto the delegate child
 * as `--provider`/`--api-key` flags (see spawnPi.ts) rather than leaning on
 * ambient env, so the bare child can't guess the wrong provider. Blank ⇒
 * undefined (the flag is omitted and Pi uses its own default/local store).
 *
 * The extension is dependency-free and cannot import src/lib/piRouting.ts, so
 * the env-var names are duplicated here as string literals; keep them in sync
 * with ENV_PI_PROVIDER / ENV_PI_API_KEY in src/lib/piRouting.ts.
 */
function piAuthFromEnv(): { provider?: string; apiKey?: string } {
  const provider = process.env.PHANTOMBOT_PI_PROVIDER?.trim();
  const apiKey = process.env.PHANTOMBOT_PI_API_KEY?.trim();
  return {
    provider: provider ? provider : undefined,
    apiKey: apiKey ? apiKey : undefined,
  };
}

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
/** Short job label for the digest header — the cwd basename, else "coder". */
function coderLabel(cwd: string | undefined): string {
  if (!cwd) return "coder";
  const base = path.basename(cwd.replace(/[\\/]+$/, ""));
  return base || "coder";
}

function makeCoderProgressSink(
  globalDefault: boolean,
  label: string,
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
  // Channel-agnostic: notify fans out to every configured channel. The digest
  // carries a `coder(<label>):` header so the user can tell delegated coder
  // work apart from the primary persona's own messages.
  //
  // Persona-scoped: bare `notify` targets the DEFAULT persona, which misroutes
  // progress to the wrong owner on a multi-persona host (Kai/Lena/Jake share a
  // box). Forward PHANTOMBOT_PERSONA so the digest reaches the persona actually
  // running this coder job. Omit the flag only when the env var is unset, so
  // single-persona hosts keep their existing default behaviour.
  const emit = (lines: string): void => {
    const body = `coder(${label}):\n${lines}`;
    const args = notifyArgs(process.env.PHANTOMBOT_PERSONA, body);
    try {
      const child = spawn("phantombot", args, {
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
    // Honour a mid-job `/viewcoder off`: if streaming was disabled after lines
    // were buffered, discard them rather than flushing a tail the user has
    // already opted out of. Otherwise drain so the final lines are never lost.
    if (!streamingEnabled()) {
      batcher.clear();
      return;
    }
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
        "ONLY for models that cannot see images themselves: if YOU already accept",
        "image input, do NOT use this tool — read the image directly instead, it is",
        "faster and cheaper. This exists so a text-only model (e.g. a coding model",
        "swapped in for a code turn) still has a way to ask about an image.",
        "Ask a specific question — this is question-driven, not a blind describe.",
      ].join(" "),
      parameters: LookAtImageParams,
      async execute(_id, params, signal) {
        const { provider, apiKey } = piAuthFromEnv();
        const r = await delegate({
          model: imageModel,
          provider,
          apiKey,
          task: imageDelegationPrompt(params.path, params.question),
          // Vision Q&A doesn't need edit/bash/write; keep it tool-light.
          tools: ["read"],
          signal,
          // Bound the delegate so a wedged vision call returns a tested failure
          // instead of hanging until the primary's own watchdog kills the turn.
          idleTimeoutMs: DELEGATE_IDLE_TIMEOUT_MS,
        });
        if (isDelegateFailure(r)) {
          return {
            content: [{ type: "text", text: delegateFailureText("look_at_image", r) }],
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
      async execute(_id, params, signal, onUpdate, ctx) {
        const cwd = params.cwd ?? ctx.cwd;
        // Job label for the digest header, e.g. `coder(phantombot):`. The cwd
        // basename ("which workspace") is the most useful at-a-glance handle;
        // fall back to a generic "coder" when there's no usable cwd.
        const label = coderLabel(cwd);
        // Build the streaming sink unconditionally so an `on` /viewcoder
        // override can force progress even when the global default is off; the
        // sink gates per emit. plan.streamCoderProgress is the global default.
        const sink = makeCoderProgressSink(plan.streamCoderProgress, label);
        const { provider, apiKey } = piAuthFromEnv();
        const r = await delegate({
          model: codingModel,
          provider,
          apiKey,
          task: coderDelegationPrompt(params.task),
          tools: ["edit", "bash", "write"],
          cwd,
          signal,
          onProgress: sink.onProgress,
          onProgressEnd: sink.onProgressEnd,
          // Bound the coder so a wedged run returns a tested failure the primary
          // can iterate on, instead of hanging until the primary's own watchdog
          // kills the whole turn (and mis-fires a harness fallback). The coder
          // is a TOOL; a tool failure must stay inside the tool boundary.
          idleTimeoutMs: DELEGATE_IDLE_TIMEOUT_MS,
          // Keep the PRIMARY fed: while the coder runs, the primary is blocked
          // awaiting this tool and emits nothing of its own, so its idle
          // watchdog would kill the turn even though the coder is working.
          // Forward the coder's liveness through pi's onUpdate — the primary
          // emits a `tool_execution_update` the harness counts as in-tool
          // activity, resetting the watchdog. Fired only on real child output,
          // so a wedged coder still hits the idle timeout above.
          onActivity: onUpdate
            ? () => onUpdate({ content: [{ type: "text", text: `coder(${label}): working…` }] })
            : undefined,
        });
        if (isDelegateFailure(r)) {
          return {
            content: [{ type: "text", text: delegateFailureText("coder", r) }],
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
