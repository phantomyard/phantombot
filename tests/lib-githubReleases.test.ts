/**
 * Tests for the GitHub Releases discovery client. Mocked fetch — no
 * network calls.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  detectSupportedArch,
  detectSupportedTarget,
  findLatestRelease,
  releaseAssetName,
} from "../src/lib/githubReleases.ts";

const SAVED_ENV = {
  PHANTOMBOT_UPDATE_REPO: process.env.PHANTOMBOT_UPDATE_REPO,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
};

beforeEach(() => {
  delete process.env.PHANTOMBOT_UPDATE_REPO;
  delete process.env.GITHUB_TOKEN;
});

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function fakeFetch(
  status: number,
  body: unknown,
  contentType = "application/json",
): typeof fetch {
  return (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": contentType },
    })) as unknown as typeof fetch;
}

/**
 * Fetch mock that returns different responses based on whether the
 * call carries an `authorization` header. Lets us assert the
 * try-unauth fallback path without race-y call counters.
 */
function authAwareFetch(
  withAuth: { status: number; body: unknown },
  noAuth: { status: number; body: unknown },
): { fetchImpl: typeof fetch; calls: Array<{ hasAuth: boolean }> } {
  const calls: Array<{ hasAuth: boolean }> = [];
  const fetchImpl = (async (
    _url: string | URL | Request,
    init?: { headers?: Record<string, string> },
  ) => {
    const headers = init?.headers ?? {};
    const hasAuth = "authorization" in headers || "Authorization" in headers;
    calls.push({ hasAuth });
    const reply = hasAuth ? withAuth : noAuth;
    return new Response(
      typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body),
      {
        status: reply.status,
        headers: { "content-type": "application/json" },
      },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const SAMPLE_RELEASE = {
  tag_name: "v1.0.43",
  published_at: "2026-05-01T00:00:00Z",
  body: "Automated release for PR #43.",
  assets: [
    {
      name: "phantombot-v1.0.43-linux-x64",
      browser_download_url: "https://example/phantombot-v1.0.43-linux-x64",
      size: 101_275_968,
    },
    {
      name: "phantombot-v1.0.43-linux-arm64",
      browser_download_url: "https://example/phantombot-v1.0.43-linux-arm64",
      size: 95_000_000,
    },
    {
      name: "SHA256SUMS",
      browser_download_url: "https://example/SHA256SUMS",
      size: 256,
    },
  ],
};

describe("detectSupportedArch", () => {
  test("x64 maps", () => expect(detectSupportedArch("x64")).toBe("x64"));
  test("arm64 maps", () => expect(detectSupportedArch("arm64")).toBe("arm64"));
  test("ia32 / ppc / etc. → undefined", () => {
    expect(detectSupportedArch("ia32")).toBeUndefined();
    expect(detectSupportedArch("ppc64")).toBeUndefined();
  });
});

describe("detectSupportedTarget", () => {
  test("linux x64/arm64", () => {
    expect(detectSupportedTarget("linux", "x64")).toBe("linux-x64");
    expect(detectSupportedTarget("linux", "arm64")).toBe("linux-arm64");
  });
  test("darwin arm64 only (no intel mac build)", () => {
    expect(detectSupportedTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(detectSupportedTarget("darwin", "x64")).toBeUndefined();
  });
  test("windows x64/arm64", () => {
    expect(detectSupportedTarget("win32", "x64")).toBe("windows-x64");
    expect(detectSupportedTarget("win32", "arm64")).toBe("windows-arm64");
  });
  test("unsupported platform/arch → undefined", () => {
    expect(detectSupportedTarget("freebsd", "x64")).toBeUndefined();
    expect(detectSupportedTarget("win32", "ia32")).toBeUndefined();
  });
});

describe("releaseAssetName", () => {
  test("POSIX targets are extensionless", () => {
    expect(releaseAssetName("v1.2.3", "linux-x64")).toBe(
      "phantombot-v1.2.3-linux-x64",
    );
    expect(releaseAssetName("v1.2.3", "darwin-arm64")).toBe(
      "phantombot-v1.2.3-darwin-arm64",
    );
  });
  test("windows targets carry the .exe suffix", () => {
    expect(releaseAssetName("v1.2.3", "windows-x64")).toBe(
      "phantombot-v1.2.3-windows-x64.exe",
    );
    expect(releaseAssetName("v1.2.3", "windows-arm64")).toBe(
      "phantombot-v1.2.3-windows-arm64.exe",
    );
  });
});

describe("findLatestRelease", () => {
  test("picks the x64 binary + SHA256SUMS, strips leading v from version", async () => {
    const r = await findLatestRelease({
      target: "linux-x64",
      fetchImpl: fakeFetch(200, SAMPLE_RELEASE),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.release.version).toBe("1.0.43");
    expect(r.release.tag).toBe("v1.0.43");
    expect(r.release.publishedAt).toBe("2026-05-01T00:00:00Z");
    expect(r.release.binary.name).toBe("phantombot-v1.0.43-linux-x64");
    expect(r.release.binary.url).toBe(
      "https://example/phantombot-v1.0.43-linux-x64",
    );
    expect(r.release.checksums.name).toBe("SHA256SUMS");
  });

  test("picks the arm64 binary on arm64 host", async () => {
    const r = await findLatestRelease({
      target: "linux-arm64",
      fetchImpl: fakeFetch(200, SAMPLE_RELEASE),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.release.binary.name).toBe("phantombot-v1.0.43-linux-arm64");
  });

  test("resolves the .exe asset for a windows target", async () => {
    const withWindows = {
      ...SAMPLE_RELEASE,
      assets: [
        ...SAMPLE_RELEASE.assets,
        {
          name: "phantombot-v1.0.43-windows-x64.exe",
          browser_download_url:
            "https://example/phantombot-v1.0.43-windows-x64.exe",
          size: 90_000_000,
        },
      ],
    };
    const r = await findLatestRelease({
      target: "windows-x64",
      fetchImpl: fakeFetch(200, withWindows),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.release.binary.name).toBe("phantombot-v1.0.43-windows-x64.exe");
    expect(r.release.binary.url).toBe(
      "https://example/phantombot-v1.0.43-windows-x64.exe",
    );
  });

  test("errors when the right-arch asset is absent", async () => {
    const partial = {
      ...SAMPLE_RELEASE,
      assets: SAMPLE_RELEASE.assets.filter((a) => a.name === "SHA256SUMS"),
    };
    const r = await findLatestRelease({
      target: "linux-x64",
      fetchImpl: fakeFetch(200, partial),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("phantombot-v1.0.43-linux-x64");
  });

  test("errors when SHA256SUMS is missing — refuses to run unverified", async () => {
    const noChecksums = {
      ...SAMPLE_RELEASE,
      assets: SAMPLE_RELEASE.assets.filter((a) => a.name !== "SHA256SUMS"),
    };
    const r = await findLatestRelease({
      target: "linux-x64",
      fetchImpl: fakeFetch(200, noChecksums),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("SHA256SUMS");
    expect(r.error).toContain("checksum verification");
  });

  test("403 → rate limit hint mentioning GITHUB_TOKEN", async () => {
    const r = await findLatestRelease({
      target: "linux-x64",
      fetchImpl: fakeFetch(403, { message: "rate limited" }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("GITHUB_TOKEN");
  });

  test("404 → 'no releases found' hint", async () => {
    const r = await findLatestRelease({
      target: "linux-x64",
      fetchImpl: fakeFetch(404, { message: "not found" }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("no releases");
  });

  test("with token, 401 from auth call retries without auth and succeeds (issue #115)", async () => {
    process.env.GITHUB_TOKEN = "ghs_pretend_app_installation_token";
    const { fetchImpl, calls } = authAwareFetch(
      { status: 401, body: { message: "Bad credentials" } },
      { status: 200, body: SAMPLE_RELEASE },
    );
    const r = await findLatestRelease({ target: "linux-x64", fetchImpl });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.release.version).toBe("1.0.43");
    expect(calls).toEqual([{ hasAuth: true }, { hasAuth: false }]);
  });

  test("with token, 403 from auth call retries without auth and succeeds", async () => {
    process.env.GITHUB_TOKEN = "ghs_pretend_token";
    const { fetchImpl, calls } = authAwareFetch(
      { status: 403, body: { message: "rate limited" } },
      { status: 200, body: SAMPLE_RELEASE },
    );
    const r = await findLatestRelease({ target: "linux-x64", fetchImpl });
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.hasAuth)).toEqual([true, false]);
  });

  test("with token, 401 then unauth also 403 → rate-limit-after-retry error", async () => {
    process.env.GITHUB_TOKEN = "ghs_pretend_token";
    const { fetchImpl } = authAwareFetch(
      { status: 401, body: { message: "Bad credentials" } },
      { status: 403, body: { message: "rate limited" } },
    );
    const r = await findLatestRelease({ target: "linux-x64", fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("even after retrying without GITHUB_TOKEN");
  });

  test("with token, 401 then unauth also 401 → labelled as unexpected", async () => {
    process.env.GITHUB_TOKEN = "ghs_pretend_token";
    const { fetchImpl } = authAwareFetch(
      { status: 401, body: { message: "Bad credentials" } },
      { status: 401, body: { message: "Bad credentials" } },
    );
    const r = await findLatestRelease({ target: "linux-x64", fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("unauth retry also rejected");
  });

  test("without token, 401 → single call, no fallback, 401 error", async () => {
    // Both branches of the mock return 401 so we can prove that the
    // no-token path makes exactly one call (no retry attempted).
    const { fetchImpl, calls } = authAwareFetch(
      { status: 401, body: { message: "Bad credentials" } },
      { status: 401, body: { message: "Bad credentials" } },
    );
    const r = await findLatestRelease({ target: "linux-x64", fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("401");
    expect(calls).toEqual([{ hasAuth: false }]);
  });

  test("with token, successful first call does not retry", async () => {
    process.env.GITHUB_TOKEN = "ghs_pretend_token";
    const { fetchImpl, calls } = authAwareFetch(
      { status: 200, body: SAMPLE_RELEASE },
      { status: 500, body: { message: "should never be called" } },
    );
    const r = await findLatestRelease({ target: "linux-x64", fetchImpl });
    expect(r.ok).toBe(true);
    expect(calls).toEqual([{ hasAuth: true }]);
  });

  test("PHANTOMBOT_UPDATE_REPO env var overrides repo", async () => {
    process.env.PHANTOMBOT_UPDATE_REPO = "fakeorg/fakerepo";
    let seenUrl: string | undefined;
    const recordingFetch = (async (url: string | URL | Request) => {
      seenUrl = String(url);
      return new Response(JSON.stringify(SAMPLE_RELEASE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await findLatestRelease({ target: "linux-x64", fetchImpl: recordingFetch });
    expect(seenUrl).toContain("fakeorg/fakerepo");
  });
});
