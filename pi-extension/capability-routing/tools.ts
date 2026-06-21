/**
 * Pure registration-decision logic for the capability-routing extension.
 *
 * Kept separate from index.ts (the @earendil-works/* glue) so it can be
 * unit-tested from phantombot's `bun test` without the Pi SDK on the import
 * path — the tests import THIS file and assert which tools should register
 * given an env snapshot.
 *
 * Reads the env-var contract documented in src/lib/piRouting.ts:
 *   PHANTOMBOT_IMAGE_MODEL  → register look_at_image (vision delegate)
 *   PHANTOMBOT_CODING_MODEL → register coder         (coding delegate)
 *   PHANTOMBOT_PRIMARY_MODEL → informational (the extension does not switch
 *                              the primary itself; phantombot's pi harness
 *                              passes --model — but we surface it for logging)
 *
 * The KEY rule: when PHANTOMBOT_IMAGE_MODEL is unset/empty, `look_at_image` is
 * NOT registered. The wizard leaves it unset precisely when the primary model
 * is multimodal (it can see images itself), so a multimodal primary gets no
 * redundant vision tool.
 */

export const ENV_PRIMARY_MODEL = "PHANTOMBOT_PRIMARY_MODEL";
export const ENV_IMAGE_MODEL = "PHANTOMBOT_IMAGE_MODEL";
export const ENV_CODING_MODEL = "PHANTOMBOT_CODING_MODEL";

export interface RoutingPlan {
  /** Primary model id, if pinned. Informational. */
  primaryModel?: string;
  /** Image model id; when present, register look_at_image. */
  imageModel?: string;
  /** Coding model id; when present, register coder. */
  codingModel?: string;
  /** True when look_at_image should be registered. */
  registerLookAtImage: boolean;
  /** True when coder should be registered. */
  registerCoder: boolean;
}

function clean(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Decide which routing tools to register from the environment. `env` is
 * injectable for tests; defaults to process.env.
 */
export function planRouting(
  env: Record<string, string | undefined> = process.env,
): RoutingPlan {
  const imageModel = clean(env[ENV_IMAGE_MODEL]);
  const codingModel = clean(env[ENV_CODING_MODEL]);
  return {
    primaryModel: clean(env[ENV_PRIMARY_MODEL]),
    imageModel,
    codingModel,
    registerLookAtImage: imageModel !== undefined,
    registerCoder: codingModel !== undefined,
  };
}

/**
 * System prompt for a vision delegation. Question-driven: the parent asks a
 * specific question about an image rather than requesting a one-shot describe,
 * so the answer is scoped to what the orchestrator actually needs.
 */
export function imageDelegationPrompt(imagePath: string, question: string): string {
  return [
    "You are a vision specialist answering a single, specific question about an image.",
    `Image: ${imagePath}`,
    `Question: ${question}`,
    "",
    "Look at the image and answer the question directly and concisely.",
    "If the image does not contain enough information to answer, say so plainly.",
    "Do not pad the answer with a full description unless the question asks for one.",
  ].join("\n");
}

/**
 * System prompt for a coding delegation. Coarse-grained: this is a fresh,
 * expensive process, so the task should be a PR/MR-scoped chunk or a review,
 * not a chatty micro-edit.
 */
export function coderDelegationPrompt(task: string): string {
  return [
    "You are a coding specialist operating in an isolated context for a PR/MR-scoped job.",
    "You have edit, bash, and write tools. Work autonomously to completion.",
    "",
    "This delegation is coarse-grained — you were spawned as a fresh process for a",
    "substantial chunk of work, not a quick question. Finish the whole task before returning.",
    "",
    `Task: ${task}`,
    "",
    "When done, report: what changed (file paths), key functions/types touched, and any caveats.",
  ].join("\n");
}
