/** Owner-authored authority. These objects are never built from model text. */
export interface SecurityPolicy {
  version: 1;
  /** Explicit opt-in while the cross-platform rollout is validated. */
  enabled: boolean;
  grants: NetworkGrant[];
}
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type NetworkGrant =
  | { id: string; kind: "npm-registry"; expiresAt: number }
  | {
      id: string;
      kind: "github-team-review";
      repository: string;
      reviewerLogin: string;
      requesterLogins: string[];
      expiresAt: number;
    }
  | {
      id: string;
      kind: "github-review";
      repository: string;
      pullRequest: number;
      expiresAt: number;
    }
  | {
      id: string;
      kind: "http";
      url: string;
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      credential?: string;
      expiresAt: number;
    }
  | {
      id: string;
      kind: "mcp";
      server: string;
      tool: string;
      /** Exact values for every argument; no implicit wildcard. */ arguments: Record<
        string,
        Json
      >;
      expiresAt: number;
    };
export type BrokerOperation =
  | { kind: "npm-package"; grant: string; name: string; version: string }
  | {
      kind: "github-checkout";
      grant: string;
      head: string;
      pullRequest?: number;
    }
  | {
      kind: "github-read";
      grant: string;
      pullRequest?: number;
      resource: "pull" | "files" | "comments" | "reviews";
    }
  | {
      kind: "github-review";
      grant: string;
      pullRequest?: number;
      head: string;
      event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
      body: string;
      comments?: {
        path: string;
        line: number;
        side: "RIGHT" | "LEFT";
        body: string;
      }[];
    }
  | { kind: "http"; grant: string; body?: string }
  | { kind: "mcp"; grant: string; arguments: Record<string, Json> };
export interface SessionDescriptor {
  url: string;
  token: string;
  workspace: string;
}
export type SecurityOutcome =
  | "allowed"
  | "policy_denied"
  | "expired"
  | "stale_head"
  | "unavailable"
  | "payload_limit";
export interface SecurityAudit {
  operation: string;
  grant?: string;
  outcome: SecurityOutcome;
  durationMs: number;
}
