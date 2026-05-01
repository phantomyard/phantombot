/**
 * Route an incoming message to an agent + harness chain.
 *
 * For now this is trivial: there's one agent (phantom), one chain
 * (whatever the config says). When/if multi-agent comes back, this is
 * where the routing rules live.
 */

import type { Harness } from "../harnesses/types.js";
import type { IncomingMessage } from "../channels/types.js";

export interface RouteDecision {
  agentDir: string;
  harnessChain: Harness[];
}

export interface Router {
  route(msg: IncomingMessage): RouteDecision;
}

export class StaticRouter implements Router {
  constructor(
    private readonly agentDir: string,
    private readonly harnessChain: Harness[],
  ) {}

  route(_msg: IncomingMessage): RouteDecision {
    return { agentDir: this.agentDir, harnessChain: this.harnessChain };
  }
}
