/**
 * Vault-backed OAuthClientProvider for MCP `oauth` servers.
 *
 * The MCP TypeScript SDK's OAuthClientProvider interface is the whole OAuth 2.1
 * engine: it drives PKCE, RFC 9728 protected-resource-metadata discovery, and
 * RFC 7591 dynamic client registration. We DO NOT reimplement any of that. Our
 * job is exactly two small things the SDK delegates back to us:
 *
 *   1. persistence  — where do tokens / the DCR client registration / the
 *                     in-flight PKCE verifier + discovery state live? Answer:
 *                     the per-persona encrypted vault, so OAuth material is
 *                     encrypted at rest and travels with the persona folder,
 *                     exactly like every other secret.
 *   2. redirect     — how does the user agent get sent to the authorization
 *                     URL, and how is the callback code captured? Answer: a
 *                     tiny loopback HTTP listener (see loopback.ts) whose URL is
 *                     the registered redirect_uri.
 *
 * Vault row layout under the server's `tokenRef` stem:
 *   <tokenRef>              — OAuthTokens JSON (access + refresh)
 *   <tokenRef>__CLIENT      — OAuthClientInformationFull JSON (DCR result)
 *   <tokenRef>__VERIFIER    — PKCE code_verifier (in-flight, cleared after use)
 *   <tokenRef>__DISCOVERY   — cached OAuthDiscoveryState JSON (latency shortcut)
 */

import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import type { Vault } from "../lib/vault.ts";

/** Suffixes appended to a server's tokenRef stem for the four OAuth vault rows. */
export const OAUTH_ROW_SUFFIX = {
  tokens: "",
  client: "__CLIENT",
  verifier: "__VERIFIER",
  discovery: "__DISCOVERY",
} as const;

export interface VaultOAuthOptions {
  /** The server's tokenRef stem (from its registry entry). */
  tokenRef: string;
  /** redirect_uri registered with the auth server — the loopback listener URL. */
  redirectUrl: string;
  /** Scopes to request, space-joined into client metadata. */
  scopes?: string[];
  /** Client name advertised in DCR. Defaults to a phantombot-branded name. */
  clientName?: string;
  /**
   * Called by the SDK when the user must be redirected to authorize. In the
   * headless/CLI login flow this prints the URL for the user to open; the
   * default just records it so `mcp login` can surface it.
   */
  onAuthorizationUrl?: (url: URL) => void | Promise<void>;
}

/**
 * OAuthClientProvider whose persistence is the persona vault. Construct one per
 * login/connection with the server's tokenRef.
 */
export class VaultOAuthClientProvider implements OAuthClientProvider {
  constructor(
    private readonly vault: Pick<Vault, "get" | "set" | "unset">,
    private readonly opts: VaultOAuthOptions,
  ) {}

  get redirectUrl(): string {
    return this.opts.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.opts.clientName ?? "phantombot",
      redirect_uris: [this.opts.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(this.opts.scopes && this.opts.scopes.length > 0
        ? { scope: this.opts.scopes.join(" ") }
        : {}),
    };
  }

  clientInformation(): OAuthClientInformation | undefined {
    const raw = this.vault.get(this.row("client"));
    if (raw === undefined) return undefined;
    return JSON.parse(raw) as OAuthClientInformationFull;
  }

  saveClientInformation(info: OAuthClientInformationFull): void {
    this.vault.set(this.row("client"), JSON.stringify(info));
  }

  tokens(): OAuthTokens | undefined {
    const raw = this.vault.get(this.row("tokens"));
    if (raw === undefined) return undefined;
    return JSON.parse(raw) as OAuthTokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.vault.set(this.row("tokens"), JSON.stringify(tokens));
    // The verifier is single-use; once tokens land it is spent.
    this.vault.unset(this.row("verifier"));
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.opts.onAuthorizationUrl?.(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.vault.set(this.row("verifier"), codeVerifier);
  }

  codeVerifier(): string {
    const v = this.vault.get(this.row("verifier"));
    if (v === undefined) {
      throw new Error(
        "mcp oauth: no PKCE code_verifier saved — start the login flow again",
      );
    }
    return v;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.vault.set(this.row("discovery"), JSON.stringify(state));
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    const raw = this.vault.get(this.row("discovery"));
    if (raw === undefined) return undefined;
    return JSON.parse(raw) as OAuthDiscoveryState;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "tokens") this.vault.unset(this.row("tokens"));
    if (scope === "all" || scope === "client") this.vault.unset(this.row("client"));
    if (scope === "all" || scope === "verifier") this.vault.unset(this.row("verifier"));
    if (scope === "all" || scope === "discovery") this.vault.unset(this.row("discovery"));
  }

  private row(kind: keyof typeof OAUTH_ROW_SUFFIX): string {
    return this.opts.tokenRef + OAUTH_ROW_SUFFIX[kind];
  }
}
