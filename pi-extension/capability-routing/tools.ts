/**
 * Pure registration-decision logic for the capability-routing extension.
 *
 * Kept separate from index.ts (the @earendil-works/* glue) so it can be
 * unit-tested from phantombot's `bun test` without the Pi SDK on the import
 * path — the tests import THIS file and assert which tools should register
 * given a routing config object.
 *
 * The config comes from a managed sibling data file `routing.json` that
 * phantombot stamps into the extension directory (see index.ts). Its shape:
 *
 *   {
 *     "primaryModel":  "...",   // informational; the extension does NOT switch
 *                               //   the primary itself — phantombot's pi harness
 *                               //   passes --model. Surfaced for logging only.
 *     "imageModel":    "...",   // present ⇒ register look_at_image (vision delegate)
 *     "codingModel":   "..."    // present ⇒ register coder         (coding delegate)
 *   }
 *
 * Every key is optional. The KEY rule: when `imageModel` is absent/empty,
 * `look_at_image` is NOT registered. phantombot now keeps `imageModel` set
 * whenever routing is configured — an explicit pick, or the primary itself when
 * the primary is multimodal — so `look_at_image` is registered even for a
 * vision-capable primary. The tool's DESCRIPTION (see index.ts) tells a model
 * that can already see images not to call it, so a multimodal primary won't,
 * while a text-only coding model swapped in for a code turn still can. Env vars
 * are NOT read by the extension — routing.json is the sole input.
 */

export interface RoutingConfig {
  primaryModel?: string;
  imageModel?: string;
  codingModel?: string;
  /**
   * Stream the coder child's per-turn progress out via `phantombot notify`
   * (channel-agnostic — reaches every configured channel, not just Telegram).
   * ON by default when a coding model is set; only an explicit `false` disables
   * it. A per-conversation `/viewcoder` override can still flip it at runtime.
   */
  codingProgress?: boolean;
}

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
  /**
   * Global default for whether the coder delegate streams its progress out via
   * `phantombot notify`. Only ever true when `registerCoder` is — progress
   * without a coder tool is meaningless, so it's force-coupled here. A
   * per-conversation `/viewcoder` override (read at emit time in index.ts) can
   * override this default on or off.
   */
  streamCoderProgress: boolean;
}

function clean(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Decide which routing tools to register from the parsed routing.json config.
 * Each field is normalized (trimmed; blank ⇒ undefined) before deciding.
 */
export function planRouting(cfg: RoutingConfig): RoutingPlan {
  const imageModel = clean(cfg.imageModel);
  const codingModel = clean(cfg.codingModel);
  const registerCoder = codingModel !== undefined;
  return {
    primaryModel: clean(cfg.primaryModel),
    imageModel,
    codingModel,
    registerLookAtImage: imageModel !== undefined,
    registerCoder,
    // Progress is coupled to the coder tool existing — never stream without it.
    // ON BY DEFAULT: with a coder registered, stream unless codingProgress is
    // explicitly false. phantombot bakes an explicit true/false into
    // routing.json, but a missing key (older asset, hand-rolled config) now
    // defaults to streaming. This is the GLOBAL default; a `/viewcoder` override
    // for a conversation can still force it on/off at emit time in index.ts.
    streamCoderProgress: registerCoder && cfg.codingProgress !== false,
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
