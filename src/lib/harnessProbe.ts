/**
 * One-shot harness smoke test — "does this brain actually answer?"
 *
 * Used by the first-run wizard's Brain step: after the user picks a primary,
 * the wizard offers to send one real prompt through the real harness adapter
 * and only counts the brain as configured when a reply comes back. This is
 * deliberately the REAL path — the same Harness classes the daemon turns run
 * — so a probe that passes means a turn will run, not merely that a binary
 * exists on PATH.
 *
 * The probe turn is maximally restricted: zero tools, zero MCP servers, a
 * one-line system prompt, and tight timeouts. It exists to prove auth +
 * model + network, nothing else.
 */

import { type Config } from "../config.ts";
import { ClaudeHarness } from "../harnesses/claude.ts";
import { CodexHarness } from "../harnesses/codex.ts";
import { PiHarness } from "../harnesses/pi.ts";
import { piInstanceSecretName } from "../harnesses/buildChain.ts";
import { resolveHarnessAvailability } from "./harnessAvailability.ts";

export interface ProbeResult {
  ok: boolean;
  /** On failure: the harness's own error (plus stderr tail). On success: the reply. */
  detail: string;
}

const PROBE_PROMPT = "Reply with exactly the word: ready";

export async function probeHarness(opts: {
  config: Config;
  /** Which chain entry to test — the PRIMARY the user just picked. */
  id: string;
  /** Injected stderr sink (tests); defaults to discard. */
  err?: { write(chunk: string): void };
}): Promise<ProbeResult> {
  // Resolve the bin against the live filesystem first — same safety nets the
  // daemon uses (harnessSearchPath sweep, absolute-bin retry), so the probe is
  // never a weaker detector than a real turn. The probed harness need not be
  // in the persona's current chain (the wizard probes BEFORE writing it), so
  // this resolves the one id directly instead of via the chain.
  const resolved = await resolveHarnessAvailability(
    opts.config,
    opts.id,
    process.env.PATH ?? "",
  );
  if (!resolved?.resolved) {
    return { ok: false, detail: `'${opts.id}' is not on PATH` };
  }
  const bin = resolved.resolved;
  const namedPi = opts.config.harnesses.instances?.[opts.id];
  const harness =
    opts.id === "pi" || namedPi?.type === "pi"
      ? new PiHarness({
          ...(namedPi ?? opts.config.harnesses.pi),
          bin,
          id: opts.id,
          ...(namedPi ? { apiKeyEnv: piInstanceSecretName(opts.id) } : {}),
        })
      : opts.id === "claude"
        ? new ClaudeHarness({
            ...opts.config.harnesses.claude,
            bin,
          })
        : new CodexHarness({
            ...(opts.config.harnesses.codex ?? { bin: "codex", model: "" }),
            bin,
          });
  try {
    for await (const chunk of harness.invoke({
      systemPrompt:
        "You are a connectivity test. Follow the user's one instruction exactly.",
      userMessage: PROBE_PROMPT,
      history: [],
      persona: opts.config.personaLayer ?? opts.config.defaultPersona,
      // Tight walls: a probe that can't answer in two minutes is a failure,
      // and idle silence past 30s already means something is wrong (auth
      // handshake, dead key, wedged proxy).
      idleTimeoutMs: 30_000,
      hardTimeoutMs: 120_000,
      startupTimeoutMs: 30_000,
      toolsMode: "none",
      mcpMode: "none",
    })) {
      if (chunk.type === "done") {
        const text = chunk.finalText.trim();
        if (text.length === 0) {
          return {
            ok: false,
            detail: "harness exited cleanly but returned an empty reply",
          };
        }
        return {
          ok: true,
          detail: (text.split("\n")[0] ?? text).slice(0, 120),
        };
      }
      if (chunk.type === "error") {
        const tail = chunk.stderrTail?.length
          ? `\n${chunk.stderrTail.slice(-3).join("\n")}`
          : "";
        return { ok: false, detail: `${chunk.error}${tail}` };
      }
      // text/heartbeat/progress: liveness only — the done/error chunk decides.
    }
    return { ok: false, detail: "harness stream ended without a reply" };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}
