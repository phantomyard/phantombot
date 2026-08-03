/**
 * Loopback OAuth redirect capture. Proves the listener binds a 127.0.0.1 port,
 * hands back a usable redirect_uri, and resolves waitForCode when the browser
 * (here: a fetch) hits the callback with ?code=. Also that an ?error= callback
 * rejects rather than hanging.
 */

import { describe, expect, test } from "bun:test";

import { startLoopbackCapture } from "../src/mcp/loopback.ts";

describe("loopback capture", () => {
  test("captures the authorization code from the redirect", async () => {
    const cap = await startLoopbackCapture();
    try {
      expect(cap.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      const wait = cap.waitForCode(5000);
      await fetch(`${cap.redirectUrl}?code=abc123&state=xyz`);
      expect(await wait).toBe("abc123");
    } finally {
      cap.close();
    }
  }, 10_000);

  test("an error callback rejects the wait", async () => {
    const cap = await startLoopbackCapture();
    try {
      // Attach the catch synchronously so the reject never lands as an
      // unhandled rejection between the two awaits.
      let captured: Error | undefined;
      const wait = cap.waitForCode(5000).catch((e: Error) => {
        captured = e;
      });
      await fetch(`${cap.redirectUrl}?error=access_denied`);
      await wait;
      expect(captured?.message).toMatch(/access_denied/);
    } finally {
      cap.close();
    }
  }, 10_000);
});
