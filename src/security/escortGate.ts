/**
 * GHSA-w7w8: the escort, moved to the sandbox boundary. Inside the sandbox a
 * bounded turn reads, edits, builds and tests unjudged — it can only damage a
 * throwaway workspace. Only what LEAVES the sandbox through the broker is
 * judged — and of that, only memory writes and owner-granted host commands
 * (workflowEscortKind): the PR loop is bounded by the broker's allowlist and
 * never stops on a hold. A kind the owner allowed goes straight through.
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
  if (WORKFLOW_GRANT_KINDS.has(grant.kind)) return workflowEscortKind(op as never);
  // github-review/team-review (owner-scoped to one PR), npm packages,
  // github-read/checkout, and owner-exact http/mcp grants: the grant decides.
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
