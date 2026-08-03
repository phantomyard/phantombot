/**
 * User-supplied (pre-registered) OAuth client support — the "skip-DCR" path.
 *
 * The `oauth` method (authProvider.ts / login.ts) normally lets the SDK register
 * a client on the fly via RFC 7591 Dynamic Client Registration (DCR). Some
 * providers — Google's remote MCP servers most notably — REJECT DCR outright
 * ("Incompatible auth server: does not support dynamic client registration").
 * For those, the user pre-registers an OAuth client in the provider's console
 * (Google Cloud Console → APIs & Services → Credentials → OAuth client ID) and
 * downloads a `credentials.json`. We ingest that once, store the client_id /
 * client_secret in the persona vault, and the provider hands them straight to
 * the SDK — which then SKIPS registration entirely (auth.js: DCR only runs when
 * `provider.clientInformation()` returns undefined).
 *
 * This module is pure parsing/shaping: no vault, no network, no SDK calls. The
 * CLI (`mcp add --client-file`) does the vault write; login.ts consumes it.
 */

import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

/** The two fields we extract from a downloaded OAuth-client credentials file. */
export interface ParsedOAuthClient {
  clientId: string;
  /** Absent for "public"/installed clients that ship no secret. */
  clientSecret?: string;
}

/**
 * Parse a Google Cloud "OAuth client" `credentials.json`. Google wraps the
 * client under `installed` (Desktop-app type) or `web` (Web-app type); some
 * tools export a flat object. We accept all three, and any provider whose
 * download uses the same client_id/client_secret shape — this is not Google-
 * specific, it just matches the common console-download format.
 */
export function parseOAuthClientFile(raw: string): ParsedOAuthClient {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`credentials file is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("credentials file must be a JSON object (an OAuth client download)");
  }
  const obj = parsed as Record<string, unknown>;
  const innerRaw = obj.installed ?? obj.web ?? obj;
  if (typeof innerRaw !== "object" || innerRaw === null || Array.isArray(innerRaw)) {
    throw new Error("credentials file: 'installed'/'web' section must be an object");
  }
  const inner = innerRaw as Record<string, unknown>;

  const clientId = inner.client_id;
  if (typeof clientId !== "string" || clientId.trim() === "") {
    throw new Error(
      "credentials file has no client_id — expected a downloaded OAuth client JSON " +
        "(Google Cloud Console → Credentials → OAuth client ID → Download JSON)",
    );
  }
  const secret = inner.client_secret;
  const clientSecret =
    typeof secret === "string" && secret.trim() !== "" ? secret : undefined;

  return { clientId, clientSecret };
}

/**
 * Shape a ParsedOAuthClient into the OAuthClientInformationFull the SDK expects
 * back from `provider.clientInformation()`. Returning this (non-undefined) is
 * exactly what makes the SDK skip DCR.
 *
 * - `redirect_uris` is left empty on purpose: the SDK drives the authorization
 *   request from `provider.redirectUrl` (the live loopback listener), not from
 *   this field, so we don't pin a port here.
 * - `token_endpoint_auth_method` picks how the token exchange authenticates:
 *   a confidential client (has a secret) uses `client_secret_post`; a public
 *   client uses `none`. selectClientAuthMethod() in the SDK honours this.
 */
export function toClientInformation(parsed: ParsedOAuthClient): OAuthClientInformationFull {
  const info = {
    client_id: parsed.clientId,
    redirect_uris: [] as string[],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: parsed.clientSecret ? "client_secret_post" : "none",
  } as OAuthClientInformationFull;
  if (parsed.clientSecret) {
    (info as { client_secret?: string }).client_secret = parsed.clientSecret;
  }
  return info;
}
