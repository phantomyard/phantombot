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
 *     "imageModel":    "..."    // present ⇒ register look_at_image (vision delegate)
 *   }
 *
 * Every key is optional. The KEY rule: when `imageModel` is absent/empty,
 * `look_at_image` is NOT registered. phantombot now keeps `imageModel` set
 * whenever routing is configured — an explicit pick, or the primary itself when
 * the primary is multimodal — so `look_at_image` is registered even for a
 * vision-capable primary. The tool's DESCRIPTION (see index.ts) tells a model
 * that can already see images not to call it, so a multimodal primary won't,
 * while a text-only coding model swapped in for a code turn still can. Model env
 * vars are NOT read by the extension — a routing.json is the sole input. WHICH
 * routing.json is chosen by `routingConfigCandidates` below (phantombot#441).
 */

export interface RoutingConfig {
  primaryModel?: string;
  imageModel?: string;
}

export interface RoutingPlan {
  /** Primary model id, if pinned. Informational. */
  primaryModel?: string;
  /** Image model id; when present, register look_at_image. */
  imageModel?: string;
  /** True when look_at_image should be registered. */
  registerLookAtImage: boolean;
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
  return {
    primaryModel: clean(cfg.primaryModel),
    imageModel,
    registerLookAtImage: imageModel !== undefined,
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
 * The routing.json files to try, in order (phantombot#441).
 *
 * The managed extension directory is stamped ONCE per host, so its sibling
 * routing.json can only ever describe one persona's delegate models. Since
 * `[harnesses]` is persona-scoped, the spawning harness writes THIS persona's
 * models to a per-turn file and names it in `PHANTOMBOT_ROUTING_JSON`. That
 * file therefore comes first.
 *
 * The sibling is the answer to an ABSENT override only, never a fallback for a
 * broken one. A `pi` run started by hand (no phantombot in the chain) sets no
 * env var and must keep working exactly as it did, so an unset var still reads
 * the sibling. But once the var is STATED it is authoritative: if that file is
 * missing, unreadable or invalid JSON, falling through to the host-stamped
 * sibling would silently hand this persona another persona's delegate models —
 * the precise isolation this override exists to provide. A stated-but-unusable
 * override therefore resolves to `{}` (no tools registered), which is the safe
 * inert state.
 *
 * A blank var is treated as unset for the same reason every other phantombot
 * env var is — an empty value is how a cleared setting looks, not a path to an
 * empty file.
 */
export function routingConfigCandidates(
  extensionDir: string | undefined,
  env: Record<string, string | undefined>,
  join: (a: string, b: string) => string,
): string[] {
  const override = env.PHANTOMBOT_ROUTING_JSON?.trim();
  if (override) return [override];
  return extensionDir ? [join(extensionDir, "routing.json")] : [];
}
