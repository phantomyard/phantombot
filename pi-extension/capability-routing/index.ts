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
import * as fs from "node:fs";
import * as path from "node:path";
import {
  imageDelegationPrompt,
  planRouting,
  type RoutingConfig,
} from "./tools.ts";
import {
  delegate,
  delegateFailureText,
  finalText,
  isDelegateFailure,
  usageLine,
} from "./spawnPi.ts";

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
}
