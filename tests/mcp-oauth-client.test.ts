/**
 * Pre-registered OAuth client (skip-DCR) — the Google-Workspace path.
 *
 * Covers the whole chain that lets a user hand phantombot a downloaded
 * `credentials.json` and connect a provider that REJECTS dynamic client
 * registration:
 *   - parsing the credentials file (installed / web / flat shapes),
 *   - shaping it into the client info the SDK consumes,
 *   - the vault-backed provider preferring the durable static client over DCR
 *     and surviving credential invalidation,
 *   - and — end to end against a fixture OAuth server — a real SDK `auth()` run
 *     that SKIPS registration and exchanges an authorization code using the
 *     pre-registered client_id/client_secret.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { generateSecretKey } from "nostr-tools/pure";

import { openVaultWithSecret, type Vault } from "../src/lib/vault.ts";
import {
  OAUTH_ROW_SUFFIX,
  staticClientVaultKey,
  VaultOAuthClientProvider,
  writeStaticClient,
} from "../src/mcp/authProvider.ts";
import { parseOAuthClientFile, toClientInformation } from "../src/mcp/oauthClient.ts";
import { referencedVaultKeys } from "../src/mcp/registry.ts";
import { rmrf } from "./fixtures/rmrf.ts";

let workdir: string;
let vault: Vault;
beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-mcp-oauth-"));
  vault = openVaultWithSecret(workdir, generateSecretKey());
});
afterEach(async () => {
  vault.close();
  await rmrf(workdir);
});

describe("parseOAuthClientFile", () => {
  const GOOGLE_DESKTOP = JSON.stringify({
    installed: {
      client_id: "123.apps.googleusercontent.com",
      project_id: "my-proj",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      client_secret: "GOCSPX-secret",
      redirect_uris: ["http://localhost"],
    },
  });

  test("Google Desktop-app 'installed' shape", () => {
    expect(parseOAuthClientFile(GOOGLE_DESKTOP)).toEqual({
      clientId: "123.apps.googleusercontent.com",
      clientSecret: "GOCSPX-secret",
    });
  });

  test("Google 'web' shape", () => {
    const raw = JSON.stringify({ web: { client_id: "web-id", client_secret: "web-secret" } });
    expect(parseOAuthClientFile(raw)).toEqual({ clientId: "web-id", clientSecret: "web-secret" });
  });

  test("flat shape with no secret (public client)", () => {
    const raw = JSON.stringify({ client_id: "public-id" });
    expect(parseOAuthClientFile(raw)).toEqual({ clientId: "public-id", clientSecret: undefined });
  });

  test("blank client_secret is treated as absent", () => {
    const raw = JSON.stringify({ installed: { client_id: "x", client_secret: "  " } });
    expect(parseOAuthClientFile(raw).clientSecret).toBeUndefined();
  });

  test("missing client_id throws a fixable error", () => {
    expect(() => parseOAuthClientFile(JSON.stringify({ installed: { project_id: "p" } }))).toThrow(
      /no client_id/,
    );
  });

  test("invalid JSON throws", () => {
    expect(() => parseOAuthClientFile("not json")).toThrow(/not valid JSON/);
  });

  test("non-object throws", () => {
    expect(() => parseOAuthClientFile("[1,2]")).toThrow(/must be a JSON object/);
  });
});

describe("toClientInformation", () => {
  test("confidential client → client_secret_post + secret carried", () => {
    const info = toClientInformation({ clientId: "cid", clientSecret: "sec" });
    expect(info.client_id).toBe("cid");
    expect((info as { client_secret?: string }).client_secret).toBe("sec");
    expect(info.token_endpoint_auth_method).toBe("client_secret_post");
    expect(info.grant_types).toEqual(["authorization_code", "refresh_token"]);
  });

  test("public client → auth method none, no secret field", () => {
    const info = toClientInformation({ clientId: "cid" });
    expect(info.token_endpoint_auth_method).toBe("none");
    expect((info as { client_secret?: string }).client_secret).toBeUndefined();
  });
});

describe("VaultOAuthClientProvider — skip-DCR precedence", () => {
  const tokenRef = "MCP_GOOGLE_OAUTH";
  const provider = () =>
    new VaultOAuthClientProvider(vault, { tokenRef, redirectUrl: "http://127.0.0.1:9/cb" });

  test("clientInformation() returns the static client when present (skips DCR)", () => {
    writeStaticClient(vault, tokenRef, toClientInformation({ clientId: "static-id", clientSecret: "s" }));
    const info = provider().clientInformation();
    expect(info?.client_id).toBe("static-id");
    expect(provider().hasStaticClient()).toBe(true);
  });

  test("static client takes precedence over a DCR-registered client", () => {
    // DCR row present…
    vault.set(tokenRef + OAUTH_ROW_SUFFIX.client, JSON.stringify({ client_id: "dcr-id" }));
    // …but a user-supplied client wins.
    writeStaticClient(vault, tokenRef, toClientInformation({ clientId: "static-id" }));
    expect(provider().clientInformation()?.client_id).toBe("static-id");
  });

  test("static client is DURABLE — invalidateCredentials('all') never wipes it", () => {
    writeStaticClient(vault, tokenRef, toClientInformation({ clientId: "static-id", clientSecret: "s" }));
    vault.set(tokenRef, JSON.stringify({ access_token: "a", token_type: "Bearer" }));
    provider().invalidateCredentials("all");
    // tokens gone, static client preserved so re-login uses it instead of DCR.
    expect(vault.get(tokenRef)).toBeUndefined();
    expect(provider().clientInformation()?.client_id).toBe("static-id");
  });

  test("no static client → falls back to DCR row (undefined when neither set)", () => {
    expect(provider().clientInformation()).toBeUndefined();
    expect(provider().hasStaticClient()).toBe(false);
  });
});

describe("registry cleanup", () => {
  test("referencedVaultKeys includes the static-client row for purge", () => {
    const keys = referencedVaultKeys({
      transport: "http",
      url: "https://x/mcp",
      auth: { type: "oauth", tokenRef: "MCP_G_OAUTH" },
    });
    expect(keys).toContain(staticClientVaultKey("MCP_G_OAUTH"));
    expect(keys).toContain("MCP_G_OAUTH__CLIENT_STATIC");
  });
});

describe("end-to-end skip-DCR via real SDK auth()", () => {
  // A minimal OAuth authorization server with NO registration_endpoint — exactly
  // the shape that makes the SDK throw "does not support dynamic client
  // registration" unless a client is pre-registered.
  function startFixtureAuthServer() {
    let registrationHit = false;
    let tokenAuthSawSecret: string | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const meta = (origin: string) => ({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
          // deliberately NO registration_endpoint
        });
        const origin = url.origin;
        // RFC 9728 protected-resource metadata: 404 → SDK falls back to origin.
        if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
          return new Response("not found", { status: 404 });
        }
        if (
          url.pathname === "/.well-known/oauth-authorization-server" ||
          url.pathname === "/.well-known/openid-configuration"
        ) {
          return Response.json(meta(origin));
        }
        if (url.pathname === "/register") {
          registrationHit = true;
          return new Response("nope", { status: 400 });
        }
        if (url.pathname === "/token" && req.method === "POST") {
          const body = new URLSearchParams(await req.text());
          tokenAuthSawSecret = body.get("client_secret") ?? undefined;
          return Response.json({
            access_token: "access-123",
            token_type: "Bearer",
            refresh_token: "refresh-123",
            expires_in: 3600,
          });
        }
        return new Response("ok");
      },
    });
    return {
      url: `${server.url.origin}/mcp`,
      close: () => server.stop(true),
      get registrationHit() {
        return registrationHit;
      },
      get tokenAuthSawSecret() {
        return tokenAuthSawSecret;
      },
    };
  }

  test("pre-registered client → DCR skipped, code exchanged with secret, tokens vaulted", async () => {
    const fx = startFixtureAuthServer();
    const tokenRef = "MCP_FIXTURE_OAUTH";
    try {
      // 1. User hands us credentials.json → we store the static client.
      const parsed = parseOAuthClientFile(
        JSON.stringify({ installed: { client_id: "pre-reg-id", client_secret: "pre-reg-secret" } }),
      );
      writeStaticClient(vault, tokenRef, toClientInformation(parsed));

      let authUrl: string | undefined;
      const provider = new VaultOAuthClientProvider(vault, {
        tokenRef,
        redirectUrl: "http://127.0.0.1:65535/callback",
        onAuthorizationUrl: (u) => {
          authUrl = u.href;
        },
      });

      // 2. First auth() call: discovery + build authorization URL. Must NOT
      //    attempt DCR because clientInformation() returns the static client.
      const first = await auth(provider, { serverUrl: fx.url });
      expect(first).toBe("REDIRECT");
      expect(fx.registrationHit).toBe(false);
      expect(vault.get(tokenRef + OAUTH_ROW_SUFFIX.client)).toBeUndefined(); // no DCR client saved
      expect(authUrl).toContain("client_id=pre-reg-id");
      expect(authUrl).toContain("code_challenge=");
      expect(vault.get(tokenRef + OAUTH_ROW_SUFFIX.verifier)).toBeDefined(); // PKCE verifier saved

      // 3. Second auth() call with the captured code: token exchange.
      const done = await auth(provider, { serverUrl: fx.url, authorizationCode: "the-code" });
      expect(done).toBe("AUTHORIZED");
      // Confidential client authenticated the token request with its secret.
      expect(fx.tokenAuthSawSecret).toBe("pre-reg-secret");
      // Tokens landed in the vault; PKCE verifier spent.
      expect(provider.tokens()?.access_token).toBe("access-123");
      expect(vault.get(tokenRef + OAUTH_ROW_SUFFIX.verifier)).toBeUndefined();
    } finally {
      fx.close();
    }
  });
});
