/**
 * Capability-routing Pi extension (phantombot).
 *
 * Lets a strong-but-narrow PRIMARY Pi model delegate specialist subtasks
 * within a single turn:
 *
 *   look_at_image(path, question) — spawns the IMAGE model to answer a
 *       specific question about an image. Registered ONLY when the primary is
 *       NOT multimodal (the wizard sets PHANTOMBOT_IMAGE_MODEL only then; if a
 *       multimodal primary is in use the env var is unset and this tool never
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
 * Reads its config from the env-var contract (see src/lib/piRouting.ts and
 * ./tools.ts). phantombot's pi harness exports these env vars to the child pi
 * process, so the extension needs zero knowledge of phantombot's config files.
 *
 * Install: symlink this directory into ~/.pi/agent/extensions/ (survives
 * `pi update`, hot-reloads with /reload). See ./README.md.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  coderDelegationPrompt,
  imageDelegationPrompt,
  planRouting,
} from "./tools.ts";
import { delegate, finalText, usageLine } from "./spawnPi.ts";

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
  const plan = planRouting();

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
        const r = await delegate({
          model: codingModel,
          task: coderDelegationPrompt(params.task),
          tools: ["edit", "bash", "write"],
          cwd: params.cwd ?? ctx.cwd,
          signal,
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
