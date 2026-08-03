/**
 * Best-effort discovery from a human-pasted "Learn More" / setup link.
 *
 * This is deliberately a HEURISTIC that hands the agent a strong first draft,
 * not magic. Given a URL it fetches the page/doc and probes any MCP endpoint,
 * then returns a structured suggestion: the likely transport, which of the
 * three auth methods applies, any scopes it spotted, and the exact human step
 * to finish. The agent reviews it, calls `mcp add`, and asks the user for the
 * one credential (or runs `mcp login`). If nothing conclusive is found the
 * result says so — the agent then declines rather than half-configuring.
 *
 * No secrets are involved here; this is read-only reconnaissance.
 */

import { timeoutSignal } from "../lib/fetchTimeout.ts";

export type SuggestedAuth = "env" | "header" | "oauth" | "none" | "unknown";

export interface DiscoverySuggestion {
  /** What we think the transport is, if determinable. */
  transport?: "stdio" | "http";
  /** stdio: a launch command we spotted (e.g. "npx"). */
  command?: string;
  /** stdio: args we spotted. */
  args?: string[];
  /** http: the MCP endpoint URL if the page looks like a remote server. */
  url?: string;
  /** Which auth method the page/probe suggests. */
  auth: SuggestedAuth;
  /** OAuth scopes spotted in the doc, if any. */
  scopes?: string[];
  /** Human-readable notes + the one setup step the agent should relay to the user. */
  notes: string[];
  /** True when we found enough to draft a registration; false = agent should decline or ask. */
  actionable: boolean;
}

/** Probe a candidate MCP HTTP endpoint: does it 401 (needs auth) or answer? */
export async function probeHttpEndpoint(url: string, timeoutMs = 8000): Promise<{
  status?: number;
  wwwAuthenticate?: string;
  error?: string;
}> {
  try {
    // A bare POST with no body is enough to see the auth posture; MCP servers
    // reject unauthenticated calls with 401 + WWW-Authenticate (RFC 9728).
    const res = await fetch(url, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream" },
      signal: timeoutSignal(timeoutMs),
    });
    return { status: res.status, wwwAuthenticate: res.headers.get("www-authenticate") ?? undefined };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * Analyse a pasted URL. Fetches the doc, applies keyword heuristics, and (if the
 * URL itself looks like an MCP endpoint) probes it. Pure best-effort — never
 * throws; on any failure returns an unactionable suggestion with the reason.
 */
export async function discoverFromUrl(rawUrl: string, timeoutMs = 8000): Promise<DiscoverySuggestion> {
  const notes: string[] = [];
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { auth: "unknown", notes: [`'${rawUrl}' is not a valid URL`], actionable: false };
  }

  // If the path smells like an MCP endpoint, treat the URL itself as the server.
  const looksLikeEndpoint = /\/(mcp|sse)(\/|$)/i.test(url.pathname);
  if (looksLikeEndpoint) {
    const probe = await probeHttpEndpoint(url.href, timeoutMs);
    if (probe.status === 401 || probe.wwwAuthenticate) {
      const oauth = /bearer|oauth|resource_metadata/i.test(probe.wwwAuthenticate ?? "");
      notes.push(
        oauth
          ? "Endpoint returned 401 with an OAuth challenge → use --oauth and run `mcp login`."
          : "Endpoint requires a token → use --header with a bearer token the user generates.",
      );
      return { transport: "http", url: url.href, auth: oauth ? "oauth" : "header", notes, actionable: true };
    }
    if (probe.status && probe.status < 400) {
      notes.push("Endpoint answered without auth → register as http with --url and no auth.");
      return { transport: "http", url: url.href, auth: "none", notes, actionable: true };
    }
    notes.push(`Probe inconclusive (${probe.status ?? probe.error ?? "no response"}).`);
  }

  // Otherwise fetch the doc and scan for install/auth hints.
  let body = "";
  try {
    const res = await fetch(url.href, {
      headers: { accept: "text/html,text/markdown,*/*" },
      signal: timeoutSignal(timeoutMs),
    });
    body = (await res.text()).slice(0, 200_000);
  } catch (err) {
    notes.push(`Could not fetch the page: ${(err as Error).message}`);
    return { auth: "unknown", notes, actionable: false };
  }

  const npx = body.match(/npx\s+(-y\s+)?[@a-z0-9/._-]+(\s+[@a-z0-9/._-]+)*/i)?.[0];
  const endpoint = body.match(/https?:\/\/[^\s"'<>)]+\/(?:mcp|sse)(?:[^\s"'<>)]*)/i)?.[0];
  const mentionsApiKey = /\bAPI[_ -]?KEY\b|access token|personal access token/i.test(body);
  const mentionsOAuth = /\boauth\b|authorize|authorization server|sign in with/i.test(body);

  if (npx) {
    const parts = npx.split(/\s+/);
    notes.push(`Found a stdio launch command in the docs: \`${npx}\`.`);
    if (mentionsApiKey) notes.push("Docs mention an API key → use --env-secret and ask the user to paste it.");
    return {
      transport: "stdio",
      command: parts[0],
      args: parts.slice(1),
      auth: mentionsApiKey ? "env" : "none",
      notes,
      actionable: true,
    };
  }

  if (endpoint) {
    notes.push(`Found a remote MCP endpoint in the docs: ${endpoint}.`);
    const auth: SuggestedAuth = mentionsOAuth ? "oauth" : mentionsApiKey ? "header" : "unknown";
    if (auth === "unknown") notes.push("Could not tell the auth method from the docs — probe with `mcp status` after adding, or ask the user.");
    return { transport: "http", url: endpoint, auth, notes, actionable: auth !== "unknown" };
  }

  notes.push("Couldn't find a stdio command or a remote MCP endpoint on this page. Ask the user for the server's setup details, or treat it as unsupported.");
  return { auth: "unknown", notes, actionable: false };
}
