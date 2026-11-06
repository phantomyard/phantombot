import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NetworkGrant, SecurityPolicy } from "./types.ts";

export const SECURITY_POLICY_FILE = "security-policy.json";
export function validatePolicy(value: unknown): SecurityPolicy {
  if (!value || typeof value !== "object")
    throw new Error("invalid security policy");
  const p = value as SecurityPolicy;
  if (
    p.version !== 1 ||
    typeof p.enabled !== "boolean" ||
    !Array.isArray(p.grants)
  )
    throw new Error("invalid security policy");
  const ids = new Set<string>();
  for (const g of p.grants) {
    if (
      !g ||
      typeof g.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(g.id) ||
      ids.has(g.id) ||
      !Number.isSafeInteger(g.expiresAt) ||
      g.expiresAt <= 0
    )
      throw new Error("invalid or duplicate grant");
    ids.add(g.id);
    if (g.kind === "npm-registry") {
      // Fixed public npm registry; no credential and no caller-provided host.
    } else if (g.kind === "github-team-review") {
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(
          g.repository,
        ) ||
        !/^[a-zA-Z0-9-]+$/.test(g.reviewerLogin) ||
        !Array.isArray(g.requesterLogins) ||
        !g.requesterLogins.length ||
        g.requesterLogins.some(
          (s) => typeof s !== "string" || !/^[a-zA-Z0-9-]+$/.test(s),
        )
      )
        throw new Error("invalid team review grant");
    } else if (g.kind === "github-review") {
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(
          g.repository,
        ) ||
        !Number.isSafeInteger(g.pullRequest) ||
        g.pullRequest < 1
      )
        throw new Error("invalid GitHub grant");
    } else if (g.kind === "http") {
      const u = new URL(g.url);
      if (
        u.protocol !== "https:" ||
        u.username ||
        u.password ||
        u.hash ||
        !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(g.method) ||
        (g.credential !== undefined && !/^[A-Z][A-Z0-9_]*$/.test(g.credential))
      )
        throw new Error("invalid HTTP grant");
    } else if (g.kind === "mcp") {
      if (
        typeof g.server !== "string" ||
        !g.server ||
        typeof g.tool !== "string" ||
        !g.tool ||
        !g.arguments ||
        Array.isArray(g.arguments) ||
        typeof g.arguments !== "object"
      )
        throw new Error("invalid MCP grant");
    } else if (g.kind === "github") {
      if (
        (g.repository !== "*" &&
          !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(g.repository)) ||
        (g.credential !== undefined && !/^[A-Z][A-Z0-9_]*$/.test(g.credential))
      )
        throw new Error("invalid GitHub workflow grant");
    } else if (g.kind === "notify" || g.kind === "memory") {
      // No parameters: the persona's own notify channel and memory store.
    } else if (g.kind === "host-command") {
      if (
        !Array.isArray(g.command) ||
        !g.command.length ||
        g.command.some((a) => typeof a !== "string" || !a || a.includes("\0")) ||
        (g.extraArgs !== undefined && typeof g.extraArgs !== "boolean")
      )
        throw new Error("invalid host command grant");
    } else throw new Error("unknown grant kind");
  }
  // Detach from the caller and freeze authority; callers never receive this copy.
  return JSON.parse(JSON.stringify(p)) as SecurityPolicy;
}
/**
 * What an untrusted turn may do with no policy file (GHSA-w7w8): GitHub PR
 * work (no merge, no default-branch push), npm packages, notify the owner,
 * and the persona's own memory. Host commands are never a default.
 */
export const DEFAULT_WORKFLOW_GRANTS: NetworkGrant[] = [
  { id: "github", kind: "github", repository: "*", expiresAt: Number.MAX_SAFE_INTEGER },
  { id: "npm", kind: "npm-registry", expiresAt: Number.MAX_SAFE_INTEGER },
  { id: "notify", kind: "notify", expiresAt: Number.MAX_SAFE_INTEGER },
  { id: "memory", kind: "memory", expiresAt: Number.MAX_SAFE_INTEGER },
];
export function defaultSecurityPolicy(): SecurityPolicy {
  return { version: 1, enabled: true, grants: JSON.parse(JSON.stringify(DEFAULT_WORKFLOW_GRANTS)) };
}
export function readSecurityPolicy(personaDir: string): SecurityPolicy {
  let text: string;
  try {
    text = readFileSync(join(personaDir, SECURITY_POLICY_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return defaultSecurityPolicy();
    throw error;
  }
  return validatePolicy(JSON.parse(text));
}
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    !a ||
    !b ||
    typeof a !== "object" ||
    typeof b !== "object" ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false;
  const ak = Object.keys(a),
    bk = Object.keys(b);
  return (
    ak.length === bk.length &&
    ak.every(
      (k) =>
        Object.hasOwn(b, k) &&
        sameJson(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        ),
    )
  );
}
export function publicGrant(g: NetworkGrant): Omit<NetworkGrant, "credential"> {
  const out = { ...g };
  if ("credential" in out) delete out.credential;
  return out;
}
