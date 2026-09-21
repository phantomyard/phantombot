/**
 * `phantombot decision-model` — the CANONICAL CLI command for the optional
 * decision model (issue #597; TypeSafe Jev today) that can front the threat
 * judge and/or the brain-swap router.
 *
 * The TUI already labels this surface by the GENERAL concept (the
 * "Decision model" row on the persona settings screen) rather than by the
 * vendor/model name, which is one provider among future ones. This command
 * standardizes the CLI on the same naming. Everything behind it — the
 * walkthrough (`src/tui/jevFlow.ts`), the write path (`applyJevConfig`),
 * the reusable-key discovery and the live key probe — lives in
 * `src/cli/jev.ts` and is shared with the TUI, so the two surfaces cannot
 * drift. `phantombot jev` remains as a deprecated alias forwarding here
 * (the `env` → `vault` pattern).
 */

import { defineCommand } from "citty";

import { runJev } from "./jev.ts";

export async function runDecisionModel(
  input: { persona?: string } = {},
): Promise<number> {
  return await runJev({ persona: input.persona });
}

export default defineCommand({
  meta: {
    name: "decision-model",
    description:
      "Configure the recommended decision model (TypeSafe Jev today) for the threat judge and/or brain-swap router. Validates the key before saving.",
  },
  args: {
    persona: {
      type: "string",
      required: false,
      description:
        "Persona to configure the decision model for. Default: PHANTOMBOT_PERSONA env, then the host's default persona.",
    },
  },
  async run({ args }) {
    process.exitCode = await runDecisionModel({
      persona: args.persona as string | undefined,
    });
  },
});
