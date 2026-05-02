/**
 * Tests for the GitHub Releases discovery client. Mocked fetch — no
 * network calls.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  detectSupportedArch,
  findLatestRelease,
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

const SAMPLE_RELEASE = {
  tag_name: "v1.0.43",
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

describe("findLatestRelease", () => {
  test("picks the x64 binary + SHA256SUMS, strips leading v from version", async () => {
    const r = await findLatestRelease({
      arch: "x64",
      fetchImpl: fakeFetch(200, SAMPLE_RELEASE),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.release.version).toBe("1.0.43");
    expect(r.release.tag).toBe("v1.0.43");
    expect(r.release.binary.name).toBe("phantombot-v1.0.43-linux-x64");
    expect(r.release.binary.url).toBe(
      "https://example/phantombot-v1.0.43-linux-x64",
    );
    expect(r.release.checksums.name).toBe("SHA256SUMS");
  });

  test("picks the arm64 binary on arm64 host", async () => {
    const r = await findLatestRelease({
      arch: "arm64",
      fetchImpl: fakeFetch(200, SAMPLE_RELEASE),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.release.binary.name).toBe("phantombot-v1.0.43-linux-arm64");
  });

  test("errors when the right-arch asset is absent", async () => {
    const partial = {
      ...SAMPLE_RELEASE,
      assets: SAMPLE_RELEASE.assets.filter((a) => a.name === "SHA256SUMS"),
    };
    const r = await findLatestRelease({
      arch: "x64",
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
      arch: "x64",
      fetchImpl: fakeFetch(200, noChecksums),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("SHA256SUMS");
    expect(r.error).toContain("checksum verification");
  });

  test("403 → rate limit hint mentioning GITHUB_TOKEN", async () => {
    const r = await findLatestRelease({
      arch: "x64",
      fetchImpl: fakeFetch(403, { message: "rate limited" }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("GITHUB_TOKEN");
  });

  test("404 → 'no releases found' hint", async () => {
    const r = await findLatestRelease({
      arch: "x64",
      fetchImpl: fakeFetch(404, { message: "not found" }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("no releases");
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
    await findLatestRelease({ arch: "x64", fetchImpl: recordingFetch });
    expect(seenUrl).toContain("fakeorg/fakerepo");
  });
});
