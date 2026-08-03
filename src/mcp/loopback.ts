/**
 * Loopback redirect capture for the MCP OAuth login flow.
 *
 * OAuth 2.1 authorization-code + PKCE needs a redirect_uri the auth server
 * sends the user back to with `?code=...`. On a normal desktop that's a
 * localhost port the client owns; we do the same — bind an ephemeral port on
 * 127.0.0.1, hand its URL to the SDK as the redirect_uri, and resolve when the
 * browser hits it. The user opens the authorization URL (in their own browser,
 * routed however they reach this host); the auth server then redirects to this
 * loopback endpoint and we read the code.
 *
 * Headless note: on a headless VPS the user's browser and this listener may be
 * on different machines. Two supported paths (issue #338 open question):
 *   - the operator port-forwards / tunnels the loopback port to their browser, or
 *   - the agent pastes the captured `?code=...` back via `mcp login --code`
 *     (see cli/mcp.ts), which skips the listener entirely.
 * This module implements the listener path; the manual-code path lives in the CLI.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface LoopbackCapture {
  /** The redirect_uri to register with the auth server (e.g. http://127.0.0.1:54321/callback). */
  redirectUrl: string;
  /** Resolves with the authorization code once the browser hits the redirect. Rejects on timeout/error param. */
  waitForCode(timeoutMs: number): Promise<string>;
  /** Stop the listener. Idempotent. */
  close(): void;
}

/**
 * Start a loopback HTTP listener on an ephemeral 127.0.0.1 port. `path` is the
 * callback path (default "/callback"). The returned redirectUrl is the full
 * URL to register as redirect_uri.
 */
export async function startLoopbackCapture(path = "/callback"): Promise<LoopbackCapture> {
  let resolveCode: ((code: string) => void) | undefined;
  let rejectCode: ((err: Error) => void) | undefined;
  let settled = false;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== path) {
      res.writeHead(404).end("not found");
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (error) {
      res.writeHead(400, { "content-type": "text/plain" }).end(`Authorization failed: ${error}`);
      if (!settled) { settled = true; rejectCode?.(new Error(`authorization error: ${error}`)); }
      return;
    }
    if (!code) {
      res.writeHead(400, { "content-type": "text/plain" }).end("Missing authorization code.");
      return;
    }
    res
      .writeHead(200, { "content-type": "text/html" })
      .end("<html><body><h3>Authorized.</h3><p>You can close this tab and return to phantombot.</p></body></html>");
    if (!settled) { settled = true; resolveCode?.(code); }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address() as AddressInfo;
  const redirectUrl = `http://127.0.0.1:${addr.port}${path}`;

  return {
    redirectUrl,
    waitForCode(timeoutMs: number): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        resolveCode = resolve;
        rejectCode = reject;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error(`timed out after ${timeoutMs}ms waiting for the OAuth redirect`));
          }
        }, timeoutMs);
        timer.unref?.();
      });
    },
    close(): void {
      try {
        server.close();
      } catch {
        /* already closed */
      }
    },
  };
}
