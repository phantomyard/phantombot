/**
 * GHSA-w7w8: the escort, moved to the sandbox boundary. Inside the sandbox a
 * bounded turn reads, edits, builds and tests unjudged — it can only damage a
 * throwaway workspace. Only what LEAVES the sandbox through the broker is
 * judged, and a kind the owner allowed (`phantombot escort allow push`) goes
 * straight through: brokered writes are already narrow by construction, so
 * an allowed kind never interrupts unattended PR work.
 */
import {
  escortBlockMessage,
  escortCheck,
  type EscortAllowKind,
  type EscortContext,
  recordEscortHold,
} from "../lib/escort.ts";
import { PolicyError } from "./broker.ts";
import type { BrokerOperation, NetworkGrant } from "./types.ts";
import { WORKFLOW_GRANT_KINDS, workflowEscortKind } from "./workflow.ts";

/** The escort kind of a brokered operation; undefined = read-only/owner-exact, not judged. */
export function brokerEscortKind(grant: NetworkGrant, op: BrokerOperation): EscortAllowKind | undefined {
  if (WORKFLOW_GRANT_KINDS.has(grant.kind)) return workflowEscortKind(grant, op as never);
  if (op.kind === "github-review") return "review";
  // npm packages, github-read/checkout, and owner-exact http/mcp grants.
  return undefined;
}

export function brokerEscortGate(
  ctx: EscortContext,
  allowances: readonly EscortAllowKind[],
  opts: Parameters<typeof escortCheck>[2] = {},
): (grant: NetworkGrant, op: BrokerOperation) => Promise<void> {
  return async (grant, op) => {
    const kind = brokerEscortKind(grant, op);
    if (!kind) return;
    const action = { tool: "broker", input: op };
    if (!ctx.deny?.includes(kind) && allowances.includes(kind)) return;
    const d = await escortCheck(ctx, action, { ...opts, brokered: { kind } });
    if (d.allow) return;
    const recorded = recordEscortHold(ctx, action, kind);
    throw new PolicyError("policy_denied", escortBlockMessage(d.reason, recorded));
  };
}
