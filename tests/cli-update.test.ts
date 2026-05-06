/**
 * End-to-end tests for `phantombot update`. Mocks fetch + ServiceControl.
 *
 * What we're trying to nail down:
 *   - Exit-code matrix for cron usage: 0/1/2 must match the spec.
 *   - Confirm-bypass with --force.
 *   - Auto-restart with --restart.
 *   - The atomic swap actually replaces the binary on disk.
 *   - Refusal modes: dev (running from bun), unsupported arch, missing
 *     SHA256SUMS asset, checksum mismatch, no write access.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUpdate } from "../src/cli/update.ts";
import type { ServiceControl } from "../src/lib/systemd.ts";

let workdir: string;
let binPath: string;

class CaptureStream {
  chunks: string[] = [];
  write(s: string | Uint8Array): boolean {
    this.chunks.push(typeof s === "string" ? s : new TextDecoder().decode(s));
    return true;
  }
  get text(): string {
    return this.chunks.join("");
  }
}

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-update-"));
  binPath = join(workdir, "phantombot");
  await writeFile(binPath, "OLD_BINARY", { mode: 0o755 });
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

const ASSET = "phantombot-v1.0.99-linux-x64";
const NEW_BYTES = Buffer.from("NEW_BINARY_VERIFIED");
const NEW_SHA = createHash("sha256").update(NEW_BYTES).digest("hex");

function fakeReleaseFetch(opts: {
  releaseStatus?: number;
  releaseBody?: unknown;
  binary?: Buffer;
  checksumsText?: string;
} = {}): typeof fetch {
  const releaseStatus = opts.releaseStatus ?? 200;
  const releaseBody = opts.releaseBody ?? {
    tag_name: "v1.0.99",
    body: "test release",
    assets: [
      {
        name: ASSET,
        browser_download_url: "https://example/" + ASSET,
        size: NEW_BYTES.byteLength,
      },
      {
        name: "phantombot-v1.0.99-linux-arm64",
        browser_download_url: "https://example/arm64",
        size: NEW_BYTES.byteLength,
      },
      {
        name: "SHA256SUMS",
        browser_download_url: "https://example/SHA256SUMS",
        size: 256,
      },
    ],
  };
  const binary = opts.binary ?? NEW_BYTES;
  const checksumsText =
    opts.checksumsText ?? `${NEW_SHA}  ${ASSET}\n`;
  return (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("api.github.com")) {
      return new Response(
        typeof releaseBody === "string"
          ? releaseBody
          : JSON.stringify(releaseBody),
        {
          status: releaseStatus,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (u.includes("SHA256SUMS")) {
      return new Response(checksumsText, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    return new Response(binary, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
  }) as unknown as typeof fetch;
}

function makeSvc(opts: { active?: boolean; restartOk?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    svc: {
      isActive: async () => {
        calls.push("isActive");
        return opts.active ?? false;
      },
      restart: async () => {
        calls.push("restart");
        return opts.restartOk === false
          ? { ok: false, stderr: "fake restart failure" }
          : { ok: true };
      },
      rerenderUnitIfStale: async () => ({ rerendered: false }),
    } as ServiceControl,
  };
}

describe("runUpdate exit codes (cron contract)", () => {
  test("already on latest → exit 0, no download", async () => {
    const out = new CaptureStream();
    const code = await runUpdate({
      binPath,
      procArch: "x64",
      currentVersion: "1.0.99",
      fetchImpl: fakeReleaseFetch(),
      out,
      err: new CaptureStream(),
      force: true,
    });
    expect(code).toBe(0);
    expect(out.text).toContain("Already on v1.0.99");
    // Binary on disk untouched.
    expect((await readFile(binPath, "utf8"))).toBe("OLD_BINARY");
  });

  test("--check + update available → exit 2, no install", async () => {
    const out = new CaptureStream();
    const code = await runUpdate({
      binPath,
      procArch: "x64",
      currentVersion: "1.0.42",
      fetchImpl: fakeReleaseFetch(),
      out,
      err: new CaptureStream(),
      check: true,
    });
    expect(code).toBe(2);
    expect(out.text).toContain("Update available");
    expect(out.text).toContain("1.0.42 → 1.0.99");
    expect((await readFile(binPath, "utf8"))).toBe("OLD_BINARY");
  });

  test("--check + already current → exit 0", async () => {
    const code = await runUpdate({
      binPath,
      procArch: "x64",
      currentVersion: "1.0.99",
      fetchImpl: fakeReleaseFetch(),
      out: new CaptureStream(),
      err: new CaptureStream(),
      check: true,
    });
    expect(code).toBe(0);
  });

  test("network error → exit 1", async () => {
    const failingFetch = (async () => {
      throw new Error("ENETUNREACH");
    }) as unknown as typeof fetch;
    const err = new CaptureStream();
    const code = await runUpdate({
      binPath,
      procArch: "x64",
      currentVersion: "1.0.42",
      fetchImpl: failingFetch,
      out: new CaptureStream(),
      err,
      force: true,
    });
    expect(code).toBe(1);
    expect(err.text).toContain("network");
  });

  test("checksum mismatch → exit 1, binary on disk untouched", async () => {
    const wrong = createHash("sha256").update(Buffer.from("evil")).digest("hex");
    const err = new CaptureStream();
    const code = await runUpdate({
      binPath,
      procArch: "x64",
      currentVersion: "1.0.42",
      fetchImpl: fakeReleaseFetch({
        checksumsText: `${wrong}  ${ASSET}\n`,
      }),
      out: new CaptureStream(),
      err,
      force: true,
    });
    expect(code).toBe(1);
    expect(err.text).toContain("SHA256 mismatch");
    expect((await readFile(binPath, "utf8"))).toBe("OLD_BINARY");
  });
});

describe("runUpdate refusals", () => {
  test("not running a phantombot binary (basename != phantombot) → exit 1", async () => {
    const wrongPath = join(workdir, "bun");
    await writeFile(wrongPath, "BUN", { mode: 0o755 });
    const err = new CaptureStream();
    const code = await runUpdate({
      binPath: wrongPath,
      procArch: "x64",
      currentVersion: "1.0.42",
      fetchImpl: fakeReleaseFetch(),
      out: new CaptureStream(),
      err,
      force: true,
    });
    expect(code).toBe(1);
    expect(err.text).toContain("source");
  });

  test("unsupported arch → exit 1", async () => {
    const err = new CaptureStream();
    const code = await runUpdate({
      binPath,
      procArch: "ia32",
      currentVersion: "1.0.42",
      fetchImpl: fakeReleaseFetch(),
      out: new CaptureStream(),
      err,
      force: true,
    });
    expect(code).toBe(1);
    expect(err.text).toContain("only released for");
  });

  test("darwin-x64 → exit 1 (Intel Mac isn't released)", async () => {
    const err = new CaptureStream();
    const code = await runUpdate({
      binPath,
      procPlatform: "darwin",
      procArch: "x64",
      currentVersion: "1.0.42",
      fetchImpl: fakeReleaseFetch(),
      out: new CaptureStream(),
      err,
      force: true,
    });
    expect(code).toBe(1);
    expect(err.text).toContain("only released for");
    expect(err.text).toContain("darwin-arm64");
    expect(err.text).toContain("platform=darwin");
  });
});

describe("runUpdate on darwin-arm64", () => {
  // On Mac, the asset name is `phantombot-vX-darwin-arm64`, not the
  // hardcoded `linux-${arch}` from before this PR. Verify the right
  // asset is fetched and the restart hint is launchctl-shaped.
  const DARWIN_ASSET = "phantombot-v1.0.99-darwin-arm64";
  const DARWIN_BYTES = Buffer.from("DARWIN_BINARY_VERIFIED");
  const DARWIN_SHA = createHash("sha256").update(DARWIN_BYTES).digest("hex");

  function darwinFetch(): typeof fetch {
    const releaseBody = {
      tag_name: "v1.0.99",
      body: "test release",
      assets: [
        {
          name: DARWIN_ASSET,
          browser_download_url: "https://example/" + DARWIN_ASSET,
          size: DARWIN_BYTES.byteLength,
        },
        {
          name: "phantombot-v1.0.99-linux-x64",
          browser_download_url: "https://example/linux-x64",
          size: DARWIN_BYTES.byteLength,
        },
        {
          name: "SHA256SUMS",
          browser_download_url: "https://example/SHA256SUMS",
          size: 256,
        },
      ],
    };
    return (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("api.github.com")) {
        return new Response(JSON.stringify(releaseBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.includes("SHA256SUMS")) {
        return new Response(`${DARWIN_SHA}  ${DARWIN_ASSET}\n`, {
          status: 200,
        });
      }
      return new Response(DARWIN_BYTES, { status: 200 });
    }) as unknown as typeof fetch;
  }

  test("picks the darwin-arm64 asset, not the linux one", async () => {
    const out = new CaptureStream();
    const code = await runUpdate({
      binPath,
      procPlatform: "darwin",
      procArch: "arm64",
      currentVersion: "1.0.42",
      fetchImpl: darwinFetch(),
      out,
      err: new CaptureStream(),
      force: true,
    });
    expect(code).toBe(0);
    expect(out.text).toContain("phantombot-v1.0.99-darwin-arm64");
    // Binary on disk is the darwin one.
    expect((await readFile(binPath)).equals(DARWIN_BYTES)).toBe(true);
  });
});

describe("runUpdate happy path with --force --restart", () => {
  test("downloads, verifies, swaps, restarts — the full cron contract", async () => {
    const out = new CaptureStream();
    const { svc, calls } = makeSvc({ active: true, restartOk: true });
    const code = await runUpdate({
      binPath,
      procArch: "x64",
      currentVersion: "1.0.42",
      fetchImpl: fakeReleaseFetch(),
      serviceControl: svc,
      out,
      err: new CaptureStream(),
      force: true,
      restart: true,
    });
    expect(code).toBe(0);
    // New binary swapped in.
    const swapped = await readFile(binPath);
    expect(swapped.equals(NEW_BYTES)).toBe(true);
    // No leftover .bak (cleaned post-swap so it doesn't pollute install dir
    // tab-completion) and no leftover .update.tmp.
    const { existsSync } = await import("node:fs");
    expect(existsSync(`${binPath}.bak`)).toBe(false);
    expect(existsSync(`${binPath}.update.tmp`)).toBe(false);
    // Restart was called (and only once).
    expect(calls.filter((c) => c === "restart")).toEqual(["restart"]);
    expect(out.text).toContain("verified");
    expect(out.text).toContain("installed v1.0.99");
    expect(out.text).toContain("restarted");
  });

  test("--force without --restart skips restart even when service is active", async () => {
    const out = new CaptureStream();
    const { svc, calls } = makeSvc({ active: true, restartOk: true });
    const code = await runUpdate({
      binPath,
      procArch: "x64",
      currentVersion: "1.0.42",
      fetchImpl: fakeReleaseFetch(),
      serviceControl: svc,
      out,
      err: new CaptureStream(),
      force: true,
      // restart NOT set
    });
    expect(code).toBe(0);
    expect(calls).not.toContain("restart");
    // No "restart with: ..." hint either, since --force is unattended.
    expect(out.text).not.toContain("restart with:");
  });

  test("restart failure doesn't fail the whole update (binary is already swapped)", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const { svc } = makeSvc({ active: true, restartOk: false });
    const code = await runUpdate({
      binPath,
      procArch: "x64",
      currentVersion: "1.0.42",
      fetchImpl: fakeReleaseFetch(),
      serviceControl: svc,
      out,
      err,
      force: true,
      restart: true,
    });
    // Exit 0 — the install succeeded; restart is best-effort.
    expect(code).toBe(0);
    expect(err.text).toContain("restart failed");
    expect(err.text).toContain("manually");
    // Binary still got swapped.
    expect((await readFile(binPath)).equals(NEW_BYTES)).toBe(true);
  });
});

describe("runUpdate confirm injection", () => {
  test("interactive: confirmInstall=false skips download entirely", async () => {
    const out = new CaptureStream();
    let confirmCalled = 0;
    const code = await runUpdate({
      binPath,
      procArch: "x64",
      currentVersion: "1.0.42",
      fetchImpl: fakeReleaseFetch(),
      out,
      err: new CaptureStream(),
      confirmInstall: async () => {
        confirmCalled++;
        return false;
      },
    });
    expect(code).toBe(0);
    expect(confirmCalled).toBe(1);
    expect(out.text).toContain("cancelled");
    expect((await readFile(binPath, "utf8"))).toBe("OLD_BINARY");
  });

  test("interactive: confirmRestart=false skips restart even when service is active", async () => {
    const { svc, calls } = makeSvc({ active: true, restartOk: true });
    const code = await runUpdate({
      binPath,
      procArch: "x64",
      currentVersion: "1.0.42",
      fetchImpl: fakeReleaseFetch(),
      serviceControl: svc,
      out: new CaptureStream(),
      err: new CaptureStream(),
      confirmInstall: async () => true,
      confirmRestart: async () => false,
    });
    expect(code).toBe(0);
    expect(calls).not.toContain("restart");
  });
});
