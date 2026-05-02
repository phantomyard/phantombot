/**
 * Tests for the SHA256-verifying download + atomic-swap helpers.
 *
 * No real network: fetch is mocked. The tests do real filesystem swaps
 * inside a per-test mkdtemp; the symlink/inode behavior of rename(2) is
 * exercised against the actual filesystem (worth doing — Linux rename
 * over a "running" target is the load-bearing assumption of update).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyUpdate,
  checkWritable,
  downloadAndVerify,
  parseSha256SumsLine,
} from "../src/lib/binaryUpdate.ts";

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-bupdate-"));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

const ASSET_NAME = "phantombot-v1.0.43-linux-x64";

function sha256(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

function fakeFetchTwo(
  binary: Buffer,
  checksumsText: string,
): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
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

describe("parseSha256SumsLine", () => {
  test("parses a standard sha256sum text-mode line", () => {
    const text =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  phantombot-v1.0.43-linux-x64\n" +
      "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210  phantombot-v1.0.43-linux-arm64\n";
    expect(
      parseSha256SumsLine(text, "phantombot-v1.0.43-linux-x64"),
    ).toBe("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
  });

  test("returns undefined for missing filename", () => {
    expect(parseSha256SumsLine("# header\n", "anything")).toBeUndefined();
  });

  test("accepts binary-mode lines (asterisk prefix)", () => {
    const text =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef *file.bin\n";
    expect(parseSha256SumsLine(text, "file.bin")).toBeDefined();
  });
});

describe("downloadAndVerify", () => {
  test("happy path: writes binary at 0o755 and returns sha256", async () => {
    const fakeBinary = Buffer.from("FAKE_PHANTOMBOT_BYTES");
    const expectedHash = sha256(fakeBinary);
    const checksums = `${expectedHash}  ${ASSET_NAME}\n`;
    const dest = join(workdir, "phantombot");
    const r = await downloadAndVerify({
      binaryUrl: "https://example/bin",
      checksumsUrl: "https://example/SHA256SUMS",
      expectedAssetName: ASSET_NAME,
      destPath: dest,
      fetchImpl: fakeFetchTwo(fakeBinary, checksums),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bytes).toBe(fakeBinary.byteLength);
    expect(r.sha256).toBe(expectedHash);
    const written = await readFile(dest);
    expect(written.equals(fakeBinary)).toBe(true);
    const { stat } = await import("node:fs/promises");
    const st = await stat(dest);
    expect(st.mode & 0o777).toBe(0o755);
  });

  test("checksum mismatch → no file left at dest", async () => {
    const fakeBinary = Buffer.from("ACTUAL_BYTES");
    const wrongHash = "f".repeat(64);
    const checksums = `${wrongHash}  ${ASSET_NAME}\n`;
    const dest = join(workdir, "phantombot");
    const r = await downloadAndVerify({
      binaryUrl: "https://example/bin",
      checksumsUrl: "https://example/SHA256SUMS",
      expectedAssetName: ASSET_NAME,
      destPath: dest,
      fetchImpl: fakeFetchTwo(fakeBinary, checksums),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("SHA256 mismatch");
    expect(existsSync(dest)).toBe(false);
  });

  test("missing SHA256SUMS entry for the asset", async () => {
    const r = await downloadAndVerify({
      binaryUrl: "https://example/bin",
      checksumsUrl: "https://example/SHA256SUMS",
      expectedAssetName: ASSET_NAME,
      destPath: join(workdir, "phantombot"),
      fetchImpl: fakeFetchTwo(Buffer.from("x"), "# empty\n"),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("no entry");
  });

  test("checksum download failure short-circuits (binary not fetched)", async () => {
    let binaryFetched = false;
    const fail404 = (async (url: string | URL | Request) => {
      if (String(url).includes("SHA256SUMS")) {
        return new Response("not found", { status: 404 });
      }
      binaryFetched = true;
      return new Response(Buffer.from("x"), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await downloadAndVerify({
      binaryUrl: "https://example/bin",
      checksumsUrl: "https://example/SHA256SUMS",
      expectedAssetName: ASSET_NAME,
      destPath: join(workdir, "phantombot"),
      fetchImpl: fail404,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("SHA256SUMS");
    expect(binaryFetched).toBe(false);
  });
});

describe("applyUpdate", () => {
  test("backs up the old binary, swaps in the new one", async () => {
    const target = join(workdir, "phantombot");
    const tmp = join(workdir, "phantombot.update.tmp");
    await writeFile(target, "OLD", { mode: 0o755 });
    await writeFile(tmp, "NEW", { mode: 0o755 });
    const r = await applyUpdate({ tempPath: tmp, targetPath: target });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.backupPath).toBe(`${target}.bak`);
    expect((await readFile(target, "utf8"))).toBe("NEW");
    expect((await readFile(r.backupPath, "utf8"))).toBe("OLD");
    // Tmp should be consumed by rename.
    expect(existsSync(tmp)).toBe(false);
  });

  test("missing tmp file → clear error", async () => {
    const r = await applyUpdate({
      tempPath: join(workdir, "no-such-file"),
      targetPath: join(workdir, "phantombot"),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("temp file missing");
  });

  test("clears a stale, unwriteable .bak before backing up", async () => {
    // Repro of the kw-openclaw failure: a .bak from a prior `sudo cp`
    // initial deploy is mode 0o644 with no write bit for the current
    // user. copyFile with O_TRUNC needs write permission on the
    // existing file; if applyUpdate doesn't unlink first, this fails
    // with EACCES even though the dir and live binary are kai-owned.
    const target = join(workdir, "phantombot");
    const backup = join(workdir, "phantombot.bak");
    const tmp = join(workdir, "phantombot.update.tmp");
    await writeFile(target, "OLD", { mode: 0o755 });
    await writeFile(tmp, "NEW", { mode: 0o755 });
    // Stale .bak with no write bit at all — simulates a foreign-owned
    // file we don't have permission to overwrite, but CAN unlink (since
    // unlink takes its perms from the parent dir).
    await writeFile(backup, "STALE_BAK", { mode: 0o444 });
    const r = await applyUpdate({ tempPath: tmp, targetPath: target });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await readFile(target, "utf8")).toBe("NEW");
    expect(await readFile(backup, "utf8")).toBe("OLD");
  });
});

describe("checkWritable", () => {
  test("ok when the parent dir is writable and target exists", async () => {
    const target = join(workdir, "phantombot");
    await writeFile(target, "x", { mode: 0o755 });
    const r = await checkWritable(target);
    expect(r.ok).toBe(true);
  });

  test("not ok when target doesn't exist (running from source)", async () => {
    const target = join(workdir, "no-such-binary");
    const r = await checkWritable(target);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("doesn't exist");
  });
});
