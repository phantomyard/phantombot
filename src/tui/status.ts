/**
 * The `/status` reading, for the Doctor screen.
 *
 * `/status` and `doctor` answer two different questions — "what is this daemon
 * doing right now?" and "is this box healthy?" — and a user in the TUI has no
 * chat to type `/status` into. So the doctor screen carries both: the checks it
 * always ran, and the live subsystem probes `/status` prints.
 *
 * The probes themselves are NOT reimplemented: `gatherStatusProbes` is the same
 * function the slash command calls, so the two can never disagree about whether
 * Telegram answers. What is left out is the part that only exists inside a live
 * channel turn (context usage, the in-flight turn, uptime) — a separate process
 * cannot read those, and inventing them would be worse than omitting them.
 */

import { gatherStatusProbes, type StatusProbeDeps } from "../channels/statusProbes.ts";
import { loadConfig } from "../config.ts";
import { DEFAULT_UPDATE_CHANNEL } from "../lib/githubReleases.ts";
import { VERSION } from "../version.ts";

/** Label/value pairs, in display order. */
export type StatusRows = Array<[string, string]>;

export async function gatherStatus(input: {
  persona: string;
  /** The persona's harness chain, as the settings screen already resolved it. */
  chain?: readonly string[];
  probes?: StatusProbeDeps;
}): Promise<StatusRows> {
  const config = await loadConfig(input.persona);
  const probes = await gatherStatusProbes(config, input.persona, input.probes);

  // The harness chain and the per-harness models, in the same words /status
  // prints them (issue #313's models line). Built here rather than taken from
  // the caller: the settings screen wants availability markers and models it
  // does not otherwise have, and Doctor wanted the chain as /status shows it —
  // one reader, so the two screens cannot disagree. Imported on demand: the
  // harness graph at module scope delayed the app's first render once already
  // (see the note on the Brain row in App.tsx).
  const rows: StatusRows = [
    ["phantom", `${input.persona} · v${VERSION}`],
    ["channel", config.updateChannel ?? DEFAULT_UPDATE_CHANNEL],
  ];
  const { buildHarnessChain } = await import("../harnesses/buildChain.ts");
  const harnesses = buildHarnessChain(config, { write: () => {} }, input.persona);
  if (harnesses.length > 0) {
    const availability = await Promise.all(harnesses.map((h) => h.available()));
    rows.push([
      "chain",
      harnesses
        .map((h, i) => `${h.id}${availability[i] ? "" : " (unavailable)"}`)
        .join(" → "),
    ]);
    const modelParts = harnesses
      .map((h) => {
        const mi = h.modelInfo?.();
        if (!mi) return undefined;
        return `${h.id}: ${mi.model}${mi.provider ? ` (${mi.provider})` : ""}`;
      })
      .filter((p): p is string => p !== undefined);
    if (modelParts.length > 0) rows.push(["models", modelParts.join(" | ")]);
  } else if (input.chain?.length) {
    rows.push(["chain", input.chain.join(" → ")]);
  }
  // Each probe line is omitted when its subsystem is not configured — same
  // rule as /status, so an absent line means "not set up", never "broken".
  if (probes.telegram) rows.push(["telegram", probes.telegram]);
  if (probes.acp) rows.push(["acp", probes.acp]);
  if (probes.memory) rows.push(["memory", probes.memory]);
  if (probes.voice) rows.push(["voice", probes.voice]);
  if (probes.dreaming) rows.push(["dreaming", probes.dreaming]);
  return rows;
}
