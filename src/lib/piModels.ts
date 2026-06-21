/**
 * Parse `pi --list-models` and reason about model capabilities.
 *
 * Pi prints a fixed-width table (no JSON flag exists for this command, so we
 * parse the text). Columns, in order:
 *
 *   provider · model · context · max-out · thinking · images
 *
 * Example row:
 *   openai      gpt-5.2                400K     128K     yes       yes
 *
 * We only need two columns downstream: the fully-qualified model id
 * (`provider/model`, which is what `pi --model` expects) and whether the
 * model accepts image input (the `images` column → multimodal capability).
 *
 * This module is the phantombot-side mirror of what the Pi extension reads
 * from `ctx.modelRegistry` (each model there carries `input: ["text"]` or
 * `["text","image"]`). We can't import the Pi SDK here — phantombot is a
 * separate binary — so the wizard shells out to `pi --list-models` and parses
 * the table, while the in-process extension uses the structured registry.
 */

/** One row from `pi --list-models`, reduced to what the wizard needs. */
export interface PiModel {
  /** Provider column, e.g. "openai", "openrouter", "deepseek". */
  provider: string;
  /**
   * Bare model name as printed, e.g. "gpt-5.2" or "~anthropic/claude-opus-latest".
   * Pi prefixes some openrouter aliases with "~"; we preserve it verbatim
   * because that is the string `pi --model` accepts.
   */
  model: string;
  /** Whether the model accepts image input (the `images` column = yes). */
  supportsImages: boolean;
}

/**
 * The header row we expect from `pi --list-models`. Used to locate the start
 * of the table and to defend against pi changing its output shape: if we never
 * see this header, we return [] rather than mis-parsing arbitrary lines.
 */
const HEADER_TOKENS = ["provider", "model", "context", "max-out", "thinking", "images"];

function isHeaderLine(line: string): boolean {
  const cols = line.trim().split(/\s+/);
  return HEADER_TOKENS.every((t, i) => cols[i] === t);
}

/**
 * Parse the raw stdout of `pi --list-models` into structured rows.
 *
 * Resilient to:
 *   - leading banner / warning lines before the header
 *   - blank lines
 *   - variable run-length whitespace between columns
 *   - a missing/extra trailing column (we read by position from the left and
 *     treat the LAST whitespace-delimited token as `images`, which is robust
 *     because every documented column after `model` is a single bare token)
 *
 * Returns [] if the header is never found (pi unavailable / output changed).
 */
export function parsePiModels(stdout: string): PiModel[] {
  const lines = stdout.split(/\r?\n/);
  const headerIdx = lines.findIndex(isHeaderLine);
  if (headerIdx === -1) return [];

  const models: PiModel[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === undefined) continue;
    if (raw.trim().length === 0) continue;
    // Split on runs of whitespace. provider · model · context · max-out ·
    // thinking · images → exactly 6 tokens for a well-formed row. We require
    // at least 6 so a stray wrapped line can't produce a bogus model.
    const cols = raw.trim().split(/\s+/);
    if (cols.length < HEADER_TOKENS.length) continue;
    const provider = cols[0]!;
    const model = cols[1]!;
    // `images` is the last column. Read it positionally from the right so a
    // future column insertion in the middle doesn't silently flip the flag.
    const imagesCol = cols[cols.length - 1]!;
    models.push({
      provider,
      model,
      supportsImages: imagesCol.toLowerCase() === "yes",
    });
  }
  return models;
}

/**
 * Spawns `pi --list-models` and returns parsed rows. Injectable runner so
 * tests drive parsing/branching without a real `pi` on PATH (mirrors the
 * SystemctlRunner pattern in systemd.ts). Returns [] on non-zero exit or
 * unparseable output — the wizard then falls back to free-text model entry.
 *
 * `bin` defaults to "pi" (PATH lookup); the wizard passes the resolved
 * absolute path from harness availability so it works under the systemd
 * unit's narrow PATH.
 */
export type PiModelsRunner = (bin: string) => Promise<{
  exitCode: number;
  stdout: string;
}>;

const defaultRunner: PiModelsRunner = async (bin) => {
  const proc = Bun.spawn([bin, "--list-models"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout };
};

export async function listPiModels(
  bin = "pi",
  runner: PiModelsRunner = defaultRunner,
): Promise<PiModel[]> {
  try {
    const { exitCode, stdout } = await runner(bin);
    if (exitCode !== 0) return [];
    return parsePiModels(stdout);
  } catch {
    return [];
  }
}

/**
 * The string `pi --model` expects. Pi accepts either the bare model name (it
 * resolves the provider) or a `provider/model` pair. We hand back the bare
 * name as printed, which is what the subagent example passes through verbatim
 * and what users see in the picker.
 */
export function modelId(m: PiModel): string {
  return m.model;
}

/**
 * Look up a model by the id the wizard stored (bare model name). Returns
 * undefined if the model is no longer offered (e.g. provider key removed).
 */
export function findModel(models: readonly PiModel[], id: string): PiModel | undefined {
  return models.find((m) => m.model === id);
}

/**
 * THE key routing decision: does the chosen primary model accept images?
 *
 * When true, the wizard SKIPS asking for an image model and the extension
 * will NOT register `look_at_image` — the primary can look at images itself,
 * so a separate vision delegate is dead weight. When the primary is unknown
 * (not in the parsed list), we conservatively return false so the image model
 * is still offered (better to over-provision a delegate than to silently lose
 * vision).
 */
export function primaryIsMultimodal(
  models: readonly PiModel[],
  primaryId: string,
): boolean {
  const m = findModel(models, primaryId);
  return m?.supportsImages ?? false;
}
