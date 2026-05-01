/**
 * Tests for the Telegram API wrapper. Uses a mocked fetch — no network.
 */

import { describe, expect, test } from "bun:test";
import { telegramGetMe } from "../src/lib/telegramApi.ts";

function fakeFetch(
  body: unknown,
  status = 200,
): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("telegramGetMe", () => {
  test("ok=true returns the bot's username + id", async () => {
    const r = await telegramGetMe(
      "abc",
      fakeFetch({
        ok: true,
        result: { id: 7, username: "phantom_bot", first_name: "Phantom" },
      }),
    );
    expect(r).toEqual({
      ok: true,
      username: "phantom_bot",
      id: 7,
      firstName: "Phantom",
    });
  });

  test("ok=false returns Telegram's error description", async () => {
    const r = await telegramGetMe(
      "abc",
      fakeFetch({ ok: false, description: "Unauthorized" }, 401),
    );
    expect(r).toEqual({ ok: false, error: "Unauthorized" });
  });

  test("network error is reported", async () => {
    const failingFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await telegramGetMe("abc", failingFetch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("network");
  });

  test("non-JSON body is reported", async () => {
    const badFetch = (async () =>
      new Response("not json", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    const r = await telegramGetMe("abc", badFetch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("non-JSON");
  });
});
