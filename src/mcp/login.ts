/**
 * OAuth login orchestration for `phantombot mcp login`.
 *
 * Ties together the three small pieces the SDK delegates to us:
 *   - VaultOAuthClientProvider (persistence in the vault)
 *   - the loopback listener (redirect capture)
 *   - the SDK's `auth()` engine (PKCE + RFC 9728 discovery + RFC 7591 DCR)
 *
 * Two flows, because a headless VPS can't always catch the browser redirect:
 *
 *   beginLogin()    -> runs discovery + DCR, prints the authorization URL, saves
 *                      the PKCE verifier in the vault, and (if the loopback is
 *                      reachable from the user's browser) waits for the callback
 *                      and finishes. Returns AUTHORIZED or PENDING(url).
 *   completeLogin() -> the manual path: the user pasted the `?code=...` back;
 *                      we exchange it for tokens using the saved verifier.
 */

import { auth } from "@modelcontextprotocol/sdk/client/auth.js";

import type { Vault } from "../lib/vault.ts";
import { VaultOAuthClientProvider } from "./authProvider.ts";
import { startLoopbackCapture } from "./loopback.ts";
import type { McpOAuthAuth, McpServerEntry } from "./registry.ts";

export type LoginResult =
  | { status: "authorized" }
  | { status: "pending"; authorizationUrl: string; redirectUrl: string };

function oauthEntry(serverId: string, entry: McpServerEntry): { url: string; auth: McpOAuthAuth } {
  if (entry.transport !== "http" || !entry.url) {
    throw new Error(`server '${serverId}' is not a remote http server — login is only for oauth servers`);
  }
  const a = entry.auth;
  if (!a || a.type !== "oauth") {
    throw new Error(`server '${serverId}' is not configured for oauth (auth.type is '${a?.type ?? "none"}')`);
  }
  return { url: entry.url, auth: a };
}

/**
 * Begin (and, when the loopback is reachable, finish) an OAuth login. When
 * `waitForRedirectMs > 0` we hold open the loopback listener and complete the
 * exchange automatically; otherwise we return `pending` with the URL so the
 * caller can drive the manual `--code` path.
 */
export async function beginLogin(
  serverId: string,
  entry: McpServerEntry,
  vault: Pick<Vault, "get" | "set" | "unset">,
  opts: { waitForRedirectMs?: number; onUrl?: (url: string) => void } = {},
): Promise<LoginResult> {
  const { url, auth: oauth } = oauthEntry(serverId, entry);
  const capture = await startLoopbackCapture();
  let authorizationUrl: string | undefined;
  const provider = new VaultOAuthClientProvider(vault, {
    tokenRef: oauth.tokenRef,
    redirectUrl: capture.redirectUrl,
    scopes: oauth.scopes,
    onAuthorizationUrl: (u) => {
      authorizationUrl = u.href;
      opts.onUrl?.(u.href);
    },
  });

  try {
    const result = await auth(provider, { serverUrl: url });
    if (result === "AUTHORIZED") {
      // Already had a valid token / completed without a redirect.
      return { status: "authorized" };
    }
    // result === "REDIRECT": provider.redirectToAuthorization has run, so we
    // have the URL and the verifier is saved. Wait for the loopback callback
    // if asked, else hand back for the manual code path.
    if (!authorizationUrl) throw new Error("oauth: SDK requested a redirect but produced no URL");
    const waitMs = opts.waitForRedirectMs ?? 0;
    if (waitMs <= 0) {
      return { status: "pending", authorizationUrl, redirectUrl: capture.redirectUrl };
    }
    let code: string;
    try {
      code = await capture.waitForCode(waitMs);
    } catch (e) {
      // Loopback never received the redirect (host unreachable, slow approval,
      // or timeout). Don't hard-fail — the manual `--code` path is still valid,
      // because the PKCE verifier is already saved in the vault. Hand back
      // pending so the caller can print the paste-the-code instructions.
      const msg = (e as Error).message;
      if (/timed out|authorization error/.test(msg)) {
        return { status: "pending", authorizationUrl, redirectUrl: capture.redirectUrl };
      }
      throw e;
    }
    const done = await auth(provider, { serverUrl: url, authorizationCode: code });
    if (done !== "AUTHORIZED") throw new Error(`oauth: token exchange returned ${done}`);
    return { status: "authorized" };
  } finally {
    capture.close();
  }
}

/**
 * Complete a login begun with the manual path: exchange a pasted authorization
 * code for tokens using the PKCE verifier saved in the vault by beginLogin.
 */
export async function completeLogin(
  serverId: string,
  entry: McpServerEntry,
  vault: Pick<Vault, "get" | "set" | "unset">,
  authorizationCode: string,
  redirectUrl: string,
): Promise<void> {
  const { url, auth: oauth } = oauthEntry(serverId, entry);
  const provider = new VaultOAuthClientProvider(vault, {
    tokenRef: oauth.tokenRef,
    redirectUrl,
    scopes: oauth.scopes,
  });
  const result = await auth(provider, { serverUrl: url, authorizationCode });
  if (result !== "AUTHORIZED") throw new Error(`oauth: token exchange returned ${result}`);
}
