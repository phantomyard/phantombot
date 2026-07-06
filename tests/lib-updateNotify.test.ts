/**
 * Tests for src/lib/updateNotify.ts — marker I/O, lastNotified dedup, and
 * the three compose functions (runUpdateFlow, checkAndNotifyOnce,
 * notifyPostRestartIfPending).
 *
 * Network is mocked via fetchImpl. Telegram is mocked via FakeTransport.
 * runUpdate (the binary-swapping CLI) is mocked via the runUpdateImpl
 * test seam so the test runner never touches process.execPath.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  TelegramMessage,
  TelegramTransport,
} from "../src/channels/telegram.ts";
import type { Config } from "../src/config.ts";
import type { ServiceControl } from "../src/lib/systemd.ts";
import {
  checkAndNotifyOnce,
  clearPendingUpdate,
  notifyPhantomchatPostRestart,
  notifyPostRestartIfPending,
  pendingUpdateChannel,
  readLastNotified,
  readPendingUpdate,
  runUpdateFlow,
  writeLastNotified,
  writePendingUpdate,
} from "../src/lib/updateNotify.ts";

let workdir: string;
let pendingPath: string;
let lastNotifiedPathLocal: string;

class FakeTransport implements TelegramTransport {
  // Core ids are channel-neutral strings (#168); updateNotify stringifies the
  // numeric recipient ids at the transport boundary.
  sent: Array<{ chatId: string; text: string }> = [];
  sendMessageImpl?: (chatId: string, text: string) => Promise<void>;
  async getUpdates(): Promise<{
    updates: TelegramMessage[];
    nextOffset: number;
  }> {
    return { updates: [], nextOffset: 0 };
  }
  async ackUpdates(): Promise<void> {}
  async sendMessage(chatId: string, text: string): Promise<void> {
    if (this.sendMessageImpl) await this.sendMessageImpl(chatId, text);
    this.sent.push({ chatId, text });
  }
  async sendTyping(): Promise<void> {}
  async sendRecording(): Promise<void> {}
  async sendVoice(): Promise<void> {}
  async downloadFile(): Promise<{ data: Buffer; mime: string }> {
    return { data: Buffer.alloc(0), mime: "" };
  }
}

function baseConfig(): Config {
  return {
    defaultPersona: "phantom",
    harnessIdleTimeoutMs: 1000,
    harnessHardTimeoutMs: 1000,
    personasDir: "/tmp",
    memoryDbPath: ":memory:",
    configPath: "/tmp/c.toml",
    harnesses: {
      chain: ["claude"],
      claude: { bin: "claude", model: "opus", fallbackModel: "sonnet" },
      pi: { bin: "pi", maxPayloadBytes: 1 },
      gemini: { bin: "gemini", model: "" },
    },
    channels: {
      telegram: {
        token: "fake-token",
        pollTimeoutS: 30,
        allowedUserIds: [42, 99],
      },
    },
    embeddings: { provider: "none" },
    voice: { provider: "none" },
  };
}

const ASSET = "phantombot-v1.0.99-linux-x64";
const NEW_BYTES = Buffer.from("NEW_BINARY_VERIFIED");
const NEW_SHA = createHash("sha256").update(NEW_BYTES).digest("hex");

function fakeReleaseFetch(opts: {
  status?: number;
  releaseBody?: unknown;
} = {}): typeof fetch {
  const status = opts.status ?? 200;
  const body = opts.releaseBody ?? {
    tag_name: "v1.0.99",
    published_at: "2026-05-01T00:00:00Z",
    body: "test release",
    assets: [
      {
        name: ASSET,
        browser_download_url: "https://example/" + ASSET,
        size: NEW_BYTES.byteLength,
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
    // Strict hostname check — substring matching can be bypassed
    // by hostile URLs like `evil.com/api.github.com`.
    let host = "";
    let path = "";
    try {
      const parsed = new URL(u);
      host = parsed.hostname;
      path = parsed.pathname;
    } catch {
      // leave host/path empty so we fall through to the binary case
    }
    if (host === "api.github.com") {
      return new Response(
        typeof body === "string" ? body : JSON.stringify(body),
        { status, headers: { "content-type": "application/json" } },
      );
    }
    if (path.endsWith("SHA256SUMS")) {
      return new Response(`${NEW_SHA}  ${ASSET}\n`, { status: 200 });
    }
    return new Response(NEW_BYTES, { status: 200 });
  }) as unknown as typeof fetch;
}

function fakeRunUpdate(exitCode: number) {
  return async (): Promise<number> => exitCode;
}

function fakeSvc(opts: { restartOk?: boolean } = {}): {
  calls: string[];
  svc: ServiceControl;
} {
  const calls: string[] = [];
  return {
    calls,
    svc: {
      async isActive() {
        calls.push("isActive");
        return true;
      },
      async start() {
        calls.push("start");
        return { ok: true };
      },
      async stop() {
        calls.push("stop");
        return { ok: true };
      },
      async restart() {
        calls.push("restart");
        return opts.restartOk === false
          ? { ok: false, stderr: "fake fail" }
          : { ok: true };
      },
      async rerenderUnitIfStale() {
        return { rerendered: false };
      },
    },
  };
}

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-updateNotify-"));
  pendingPath = join(workdir, ".pending-update.json");
  lastNotifiedPathLocal = join(workdir, ".last-update-notified");
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Marker file I/O
// ---------------------------------------------------------------------------

describe("pending-update marker", () => {
  test("write/read round-trip preserves all fields", async () => {
    const marker = {
      targetVersion: "1.0.99",
      targetTag: "v1.0.99",
      chatId: 42,
      persona: "miles",
      previousVersion: "1.0.42",
      writtenAt: "2026-05-11T09:00:00.000Z",
    };
    await writePendingUpdate(marker, pendingPath);
    const read = await readPendingUpdate(pendingPath);
    expect(read).toEqual(marker);
  });

  test("readPendingUpdate returns undefined when missing", async () => {
    const r = await readPendingUpdate(join(workdir, "nonexistent.json"));
    expect(r).toBeUndefined();
  });

  test("readPendingUpdate returns undefined on malformed JSON", async () => {
    await writeFile(pendingPath, "{not json", "utf8");
    const r = await readPendingUpdate(pendingPath);
    expect(r).toBeUndefined();
  });

  test("readPendingUpdate rejects markers missing required fields", async () => {
    await writeFile(
      pendingPath,
      JSON.stringify({ targetVersion: "1.0.99" }),
      "utf8",
    );
    const r = await readPendingUpdate(pendingPath);
    expect(r).toBeUndefined();
  });

  test("clearPendingUpdate is idempotent (no-op when absent)", async () => {
    // Should not throw even with no marker.
    await clearPendingUpdate(pendingPath);
    // Now write one and clear it.
    await writePendingUpdate(
      {
        targetVersion: "1.0.99",
        targetTag: "v1.0.99",
        previousVersion: "1.0.42",
        writtenAt: "2026-05-11T00:00:00Z",
      },
      pendingPath,
    );
    await clearPendingUpdate(pendingPath);
    const r = await readPendingUpdate(pendingPath);
    expect(r).toBeUndefined();
  });

  test("chatId is optional in the marker", async () => {
    const marker = {
      targetVersion: "1.0.99",
      targetTag: "v1.0.99",
      previousVersion: "1.0.42",
      writtenAt: "2026-05-11T00:00:00Z",
    };
    await writePendingUpdate(marker, pendingPath);
    const read = await readPendingUpdate(pendingPath);
    expect(read?.chatId).toBeUndefined();
    expect(read?.targetTag).toBe("v1.0.99");
  });
});

// ---------------------------------------------------------------------------
// Last-notified dedup file
// ---------------------------------------------------------------------------

describe("last-notified dedup", () => {
  test("write/read round-trip", async () => {
    await writeLastNotified("1.0.99", lastNotifiedPathLocal);
    const r = await readLastNotified(lastNotifiedPathLocal);
    expect(r).toBe("1.0.99");
  });

  test("returns undefined when missing", async () => {
    const r = await readLastNotified(join(workdir, "absent"));
    expect(r).toBeUndefined();
  });

  test("trims whitespace on read", async () => {
    await writeFile(lastNotifiedPathLocal, "  1.0.99  \n", "utf8");
    const r = await readLastNotified(lastNotifiedPathLocal);
    expect(r).toBe("1.0.99");
  });
});

// ---------------------------------------------------------------------------
// runUpdateFlow (/update slash command)
// ---------------------------------------------------------------------------

describe("runUpdateFlow", () => {
  test("already on latest → 'nothing to do', no marker written, no restart", async () => {
    const { calls, svc } = fakeSvc();
    const r = await runUpdateFlow({
      config: baseConfig(),
      currentVersion: "1.0.99",
      chatId: 42,
      fetchImpl: fakeReleaseFetch(),
      serviceControl: svc,
      runUpdateImpl: fakeRunUpdate(0),
      pendingPath,
      lastNotifiedPath: lastNotifiedPathLocal,
      procPlatform: "linux",
      procArch: "x64",
    });
    expect(r.reply).toContain("already on v1.0.99");
    expect(r.restart).toBeUndefined();
    expect(await readPendingUpdate(pendingPath)).toBeUndefined();
    expect(calls).not.toContain("restart");
  });

  test("update available → writes marker, swaps binary, returns restart() callback", async () => {
    const { calls, svc } = fakeSvc();
    let runUpdateCalledWith: unknown;
    const r = await runUpdateFlow({
      config: baseConfig(),
      currentVersion: "1.0.42",
      chatId: 42,
      fetchImpl: fakeReleaseFetch(),
      serviceControl: svc,
      runUpdateImpl: async (i) => {
        runUpdateCalledWith = i;
        return 0;
      },
      pendingPath,
      lastNotifiedPath: lastNotifiedPathLocal,
      procPlatform: "linux",
      procArch: "x64",
    });
    expect(r.reply).toContain("installed v1.0.99");
    expect(r.reply).toContain("was 1.0.42");
    expect(r.restart).toBeDefined();
    // Marker was written.
    const marker = await readPendingUpdate(pendingPath);
    expect(marker?.targetVersion).toBe("1.0.99");
    expect(marker?.targetTag).toBe("v1.0.99");
    expect(marker?.chatId).toBe(42);
    expect(marker?.persona).toBeUndefined();
    expect(marker?.previousVersion).toBe("1.0.42");
    // runUpdate was invoked with force:true, restart:false (we control
    // the restart ourselves so it can fire AFTER the reply lands).
    expect((runUpdateCalledWith as { force: boolean }).force).toBe(true);
    expect((runUpdateCalledWith as { restart: boolean }).restart).toBe(false);
    // Last-notified bumped so heartbeat doesn't re-spam mid-restart.
    expect(await readLastNotified(lastNotifiedPathLocal)).toBe("1.0.99");
    // restart() not called yet — caller's responsibility, post-sendMessage.
    expect(calls).not.toContain("restart");
    // Invoke it and verify it routes to the injected ServiceControl.
    await r.restart!();
    expect(calls).toContain("restart");
  });

  test("update available from persona listener → stores persona in marker", async () => {
    const r = await runUpdateFlow({
      config: baseConfig(),
      currentVersion: "1.0.42",
      chatId: 42,
      persona: "miles",
      fetchImpl: fakeReleaseFetch(),
      serviceControl: fakeSvc().svc,
      runUpdateImpl: fakeRunUpdate(0),
      pendingPath,
      lastNotifiedPath: lastNotifiedPathLocal,
      procPlatform: "linux",
      procArch: "x64",
    });
    expect(r.reply).toContain("installed v1.0.99");
    const marker = await readPendingUpdate(pendingPath);
    expect(marker?.persona).toBe("miles");
  });

  test("update available but runUpdate exits non-zero → marker cleared, error reply", async () => {
    const r = await runUpdateFlow({
      config: baseConfig(),
      currentVersion: "1.0.42",
      chatId: 42,
      fetchImpl: fakeReleaseFetch(),
      serviceControl: fakeSvc().svc,
      runUpdateImpl: fakeRunUpdate(1),
      pendingPath,
      lastNotifiedPath: lastNotifiedPathLocal,
      procPlatform: "linux",
      procArch: "x64",
    });
    expect(r.reply).toContain("failed");
    expect(r.reply).toContain("exit 1");
    expect(r.restart).toBeUndefined();
    expect(await readPendingUpdate(pendingPath)).toBeUndefined();
  });

  test("release-check failure → returns error reply, no marker, no swap", async () => {
    const failingFetch = (async () => {
      throw new Error("ENETUNREACH");
    }) as unknown as typeof fetch;
    let runUpdateCalled = false;
    const r = await runUpdateFlow({
      config: baseConfig(),
      currentVersion: "1.0.42",
      chatId: 42,
      fetchImpl: failingFetch,
      runUpdateImpl: async () => {
        runUpdateCalled = true;
        return 0;
      },
      pendingPath,
      lastNotifiedPath: lastNotifiedPathLocal,
      procPlatform: "linux",
      procArch: "x64",
    });
    expect(r.reply).toContain("couldn't check");
    expect(r.restart).toBeUndefined();
    expect(runUpdateCalled).toBe(false);
    expect(await readPendingUpdate(pendingPath)).toBeUndefined();
  });

  test("unsupported platform → explicit refusal, no swap", async () => {
    let runUpdateCalled = false;
    const r = await runUpdateFlow({
      config: baseConfig(),
      currentVersion: "1.0.42",
      chatId: 42,
      fetchImpl: fakeReleaseFetch(),
      runUpdateImpl: async () => {
        runUpdateCalled = true;
        return 0;
      },
      pendingPath,
      lastNotifiedPath: lastNotifiedPathLocal,
      // freebsd is genuinely unreleased (win32 IS supported since the
      // Windows self-update work — see the win32 case below).
      procPlatform: "freebsd",
      procArch: "x64",
    });
    expect(r.reply).toContain("can't self-update");
    expect(r.reply).toContain("platform=freebsd");
    expect(r.restart).toBeUndefined();
    expect(runUpdateCalled).toBe(false);
  });

  test("win32 → supported: swaps and returns a restart() callback", async () => {
    const { svc } = fakeSvc();
    let runUpdateCalledWith: unknown;
    // The release must carry the `.exe` asset for a windows target, so
    // findLatestRelease (which runUpdateFlow calls before the swap) resolves.
    const winReleaseBody = {
      tag_name: "v1.0.99",
      published_at: "2026-05-01T00:00:00Z",
      body: "test release",
      assets: [
        {
          name: "phantombot-v1.0.99-windows-x64.exe",
          browser_download_url:
            "https://example/phantombot-v1.0.99-windows-x64.exe",
          size: 123,
        },
        {
          name: "SHA256SUMS",
          browser_download_url: "https://example/SHA256SUMS",
          size: 256,
        },
      ],
    };
    const r = await runUpdateFlow({
      config: baseConfig(),
      currentVersion: "1.0.42",
      chatId: 42,
      fetchImpl: fakeReleaseFetch({ releaseBody: winReleaseBody }),
      serviceControl: svc,
      runUpdateImpl: async (opts) => {
        runUpdateCalledWith = opts;
        return 0;
      },
      pendingPath,
      lastNotifiedPath: lastNotifiedPathLocal,
      procPlatform: "win32",
      procArch: "x64",
    });
    // Windows is a real release target now — the flow proceeds to a swap.
    expect(r.reply).toContain("installed");
    expect(r.restart).toBeDefined();
    // runUpdate saw win32 so it takes the rename-aside swap path.
    expect((runUpdateCalledWith as { procPlatform: string }).procPlatform).toBe(
      "win32",
    );
    // NB: we deliberately don't invoke r.restart() here. On win32 selfRestart's
    // default shutdown trigger is process.emit("SIGTERM"), which would signal
    // the test runner. The "Windows exits cleanly, never calls schtasks
    // restart()" behaviour is asserted in lib-platform.test.ts with an injected
    // trigger.
  });
});

// ---------------------------------------------------------------------------
// checkAndNotifyOnce (heartbeat hook)
// ---------------------------------------------------------------------------

describe("checkAndNotifyOnce", () => {
  test("update available + nothing previously notified → sends one message per recipient, writes dedup", async () => {
    const transport = new FakeTransport();
    const r = await checkAndNotifyOnce({
      config: baseConfig(),
      currentVersion: "1.0.42",
      now: new Date("2026-05-05T00:00:00Z"),
      fetchImpl: fakeReleaseFetch(),
      transport,
      lastNotifiedPath: lastNotifiedPathLocal,
      procPlatform: "linux",
      procArch: "x64",
    });
    expect(r.status).toBe("notified");
    expect(r.latestVersion).toBe("1.0.99");
    expect(r.notifiedRecipients).toBe(2);
    expect(transport.sent.length).toBe(2);
    expect(transport.sent[0]!.text).toContain("v1.0.99");
    expect(transport.sent[0]!.text).toContain("/update");
    expect(await readLastNotified(lastNotifiedPathLocal)).toBe("1.0.99");
  });

  test("update available but younger than 72 hours → records first seen without notifying", async () => {
    const transport = new FakeTransport();
    const r = await checkAndNotifyOnce({
      config: baseConfig(),
      currentVersion: "1.0.42",
      now: new Date("2026-05-02T00:00:00Z"),
      fetchImpl: fakeReleaseFetch({
        releaseBody: {
          tag_name: "v1.0.99",
          published_at: "2026-05-01T00:00:00Z",
          body: "test release",
          assets: [
            {
              name: ASSET,
              browser_download_url: "https://example/" + ASSET,
              size: NEW_BYTES.byteLength,
            },
            {
              name: "SHA256SUMS",
              browser_download_url: "https://example/SHA256SUMS",
              size: 256,
            },
          ],
        },
      }),
      transport,
      lastNotifiedPath: lastNotifiedPathLocal,
      procPlatform: "linux",
      procArch: "x64",
    });
    expect(r.status).toBe("waiting_delay");
    expect(r.latestVersion).toBe("1.0.99");
    expect(transport.sent.length).toBe(0);
    expect(await readLastNotified(lastNotifiedPathLocal)).toBeUndefined();
  });

  test("same pending release notifies after the 72-hour delay", async () => {
    const first = await checkAndNotifyOnce({
      config: baseConfig(),
      currentVersion: "1.0.42",
      now: new Date("2026-05-02T00:00:00Z"),
      fetchImpl: fakeReleaseFetch({
        releaseBody: {
          tag_name: "v1.0.99",
          body: "test release",
          assets: [
            {
              name: ASSET,
              browser_download_url: "https://example/" + ASSET,
              size: NEW_BYTES.byteLength,
            },
            {
              name: "SHA256SUMS",
              browser_download_url: "https://example/SHA256SUMS",
              size: 256,
            },
          ],
        },
      }),
      transport: new FakeTransport(),
      lastNotifiedPath: lastNotifiedPathLocal,
      procPlatform: "linux",
      procArch: "x64",
    });
    expect(first.status).toBe("waiting_delay");

    const transport = new FakeTransport();
    const second = await checkAndNotifyOnce({
      config: baseConfig(),
      currentVersion: "1.0.42",
      now: new Date("2026-05-05T00:00:01Z"),
      fetchImpl: fakeReleaseFetch({
        releaseBody: {
          tag_name: "v1.0.99",
          body: "test release",
          assets: [
            {
              name: ASSET,
              browser_download_url: "https://example/" + ASSET,
              size: NEW_BYTES.byteLength,
            },
            {
              name: "SHA256SUMS",
              browser_download_url: "https://example/SHA256SUMS",
              size: 256,
            },
          ],
        },
      }),
      transport,
      lastNotifiedPath: lastNotifiedPathLocal,
      procPlatform: "linux",
      procArch: "x64",
    });
    expect(second.status).toBe("notified");
    expect(transport.sent.length).toBe(2);
    expect(await readLastNotified(lastNotifiedPathLocal)).toBe("1.0.99");
  });

  test("already_current → no sends, no dedup write", async () => {
    const transport = new FakeTransport();
    const r = await checkAndNotifyOnce({
      config: baseConfig(),
      currentVersion: "1.0.99",
      fetchImpl: fakeReleaseFetch(),
      transport,
      lastNotifiedPath: lastNotifiedPathLocal,
      procPlatform: "linux",
      procArch: "x64",
    });
    expect(r.status).toBe("already_current");
    expect(transport.sent.length).toBe(0);
    expect(await readLastNotified(lastNotifiedPathLocal)).toBeUndefined();
  });

  test("already_notified → no sends (dedup wins)", async () => {
    await writeLastNotified("1.0.99", lastNotifiedPathLocal);
    const transport = new FakeTransport();
    const r = await checkAndNotifyOnce({
      config: baseConfig(),
      currentVersion: "1.0.42",
      fetchImpl: fakeReleaseFetch(),
      transport,
      lastNotifiedPath: lastNotifiedPathLocal,
      procPlatform: "linux",
      procArch: "x64",
    });
    expect(r.status).toBe("already_notified");
    expect(transport.sent.length).toBe(0);
  });

  test("idempotent across two consecutive heartbeats", async () => {
    const transport = new FakeTransport();
    const input = {
      config: baseConfig(),
      currentVersion: "1.0.42",
      fetchImpl: fakeReleaseFetch(),
      transport,
      lastNotifiedPath: lastNotifiedPathLocal,
      procPlatform: "linux",
      procArch: "x64",
    };
    const first = await checkAndNotifyOnce(input);
    expect(first.status).toBe("notified");
    expect(transport.sent.length).toBe(2);
    const second = await checkAndNotifyOnce(input);
    expect(second.status).toBe("already_notified");
    expect(transport.sent.length).toBe(2); // unchanged
  });

  test("no telegram configured → status no_telegram, no calls to fetch", async () => {
    const cfg = baseConfig();
    cfg.channels.telegram = undefined;
    let fetched = false;
    const noFetch = (async () => {
      fetched = true;
      throw new Error("should not have fetched");
    }) as unknown as typeof fetch;
    const r = await checkAndNotifyOnce({
      config: cfg,
      currentVersion: "1.0.42",
      fetchImpl: noFetch,
      lastNotifiedPath: lastNotifiedPathLocal,
      procPlatform: "linux",
      procArch: "x64",
    });
    expect(r.status).toBe("no_telegram");
    expect(fetched).toBe(false);
  });

  test("unsupported platform → status no_target", async () => {
    const r = await checkAndNotifyOnce({
      config: baseConfig(),
      currentVersion: "1.0.42",
      fetchImpl: fakeReleaseFetch(),
      transport: new FakeTransport(),
      lastNotifiedPath: lastNotifiedPathLocal,
      // freebsd has no release target (win32 is supported now).
      procPlatform: "freebsd",
      procArch: "x64",
    });
    expect(r.status).toBe("no_target");
  });

  test("github error → status release_check_failed, no notify, no dedup change", async () => {
    const failingFetch = (async () => {
      throw new Error("ENETUNREACH");
    }) as unknown as typeof fetch;
    const transport = new FakeTransport();
    const r = await checkAndNotifyOnce({
      config: baseConfig(),
      currentVersion: "1.0.42",
      fetchImpl: failingFetch,
      transport,
      lastNotifiedPath: lastNotifiedPathLocal,
      procPlatform: "linux",
      procArch: "x64",
    });
    expect(r.status).toBe("release_check_failed");
    expect(transport.sent.length).toBe(0);
    expect(await readLastNotified(lastNotifiedPathLocal)).toBeUndefined();
  });

  test("empty allowed_user_ids → status no_allowed_users, refuses to broadcast", async () => {
    const cfg = baseConfig();
    cfg.channels.telegram!.allowedUserIds = [];
    const transport = new FakeTransport();
    const r = await checkAndNotifyOnce({
      config: cfg,
      currentVersion: "1.0.42",
      fetchImpl: fakeReleaseFetch(),
      transport,
      lastNotifiedPath: lastNotifiedPathLocal,
      procPlatform: "linux",
      procArch: "x64",
    });
    expect(r.status).toBe("no_allowed_users");
    expect(transport.sent.length).toBe(0);
  });

  test("dedup writes even on partial send failure (better one missed than one re-pinged)", async () => {
    const transport = new FakeTransport();
    transport.sendMessageImpl = async (chatId) => {
      if (chatId === "99") throw new Error("rate limited");
    };
    const r = await checkAndNotifyOnce({
      config: baseConfig(),
      currentVersion: "1.0.42",
      fetchImpl: fakeReleaseFetch(),
      transport,
      lastNotifiedPath: lastNotifiedPathLocal,
      procPlatform: "linux",
      procArch: "x64",
    });
    expect(r.status).toBe("notified");
    expect(r.notifiedRecipients).toBe(1); // only chatId 42 succeeded
    expect(await readLastNotified(lastNotifiedPathLocal)).toBe("1.0.99");
  });
});

// ---------------------------------------------------------------------------
// notifyPostRestartIfPending (run.ts startup hook)
// ---------------------------------------------------------------------------

describe("notifyPostRestartIfPending", () => {
  test("no marker → no-op, no notify", async () => {
    const transport = new FakeTransport();
    const r = await notifyPostRestartIfPending({
      config: baseConfig(),
      currentVersion: "1.0.99",
      transport,
      pendingPath,
    });
    expect(r.status).toBe("no_marker");
    expect(transport.sent.length).toBe(0);
  });

  test("marker matches current version → success notify to marker.chatId only, marker cleared", async () => {
    await writePendingUpdate(
      {
        targetVersion: "1.0.99",
        targetTag: "v1.0.99",
        chatId: 42,
        previousVersion: "1.0.42",
        writtenAt: "2026-05-11T00:00:00Z",
      },
      pendingPath,
    );
    const transport = new FakeTransport();
    const r = await notifyPostRestartIfPending({
      config: baseConfig(),
      currentVersion: "1.0.99",
      transport,
      pendingPath,
    });
    expect(r.status).toBe("success_notified");
    // Only sent to chatId 42 (from marker), NOT broadcast to allowedUserIds.
    expect(transport.sent.length).toBe(1);
    expect(transport.sent[0]!.chatId).toBe("42");
    expect(transport.sent[0]!.text).toContain("✅");
    expect(transport.sent[0]!.text).toContain("v1.0.99");
    expect(transport.sent[0]!.text).toContain("v1.0.42");
    // Marker gone.
    expect(await readPendingUpdate(pendingPath)).toBeUndefined();
  });

  test("marker doesn't match current version → failure notify, marker cleared", async () => {
    await writePendingUpdate(
      {
        targetVersion: "1.0.99",
        targetTag: "v1.0.99",
        chatId: 42,
        previousVersion: "1.0.42",
        writtenAt: "2026-05-11T00:00:00Z",
      },
      pendingPath,
    );
    const transport = new FakeTransport();
    const r = await notifyPostRestartIfPending({
      config: baseConfig(),
      currentVersion: "1.0.42", // didn't take
      transport,
      pendingPath,
    });
    expect(r.status).toBe("failure_notified");
    expect(transport.sent[0]!.text).toContain("⚠️");
    expect(transport.sent[0]!.text).toContain("didn't take");
    expect(transport.sent[0]!.text).toContain("v1.0.99");
    expect(await readPendingUpdate(pendingPath)).toBeUndefined();
  });

  test("marker without chatId → broadcasts to allowed_user_ids", async () => {
    await writePendingUpdate(
      {
        targetVersion: "1.0.99",
        targetTag: "v1.0.99",
        previousVersion: "1.0.42",
        writtenAt: "2026-05-11T00:00:00Z",
      },
      pendingPath,
    );
    const transport = new FakeTransport();
    const r = await notifyPostRestartIfPending({
      config: baseConfig(),
      currentVersion: "1.0.99",
      transport,
      pendingPath,
    });
    expect(r.status).toBe("success_notified");
    // No chatId in marker → broadcast to BOTH allowed users.
    expect(transport.sent.map((s) => s.chatId).sort()).toEqual(["42", "99"]);
  });

  test("no telegram configured → clears marker without notify, returns status no_telegram", async () => {
    const cfg = baseConfig();
    cfg.channels.telegram = undefined;
    await writePendingUpdate(
      {
        targetVersion: "1.0.99",
        targetTag: "v1.0.99",
        chatId: 42,
        previousVersion: "1.0.42",
        writtenAt: "2026-05-11T00:00:00Z",
      },
      pendingPath,
    );
    const transport = new FakeTransport();
    const r = await notifyPostRestartIfPending({
      config: cfg,
      currentVersion: "1.0.99",
      transport,
      pendingPath,
    });
    expect(r.status).toBe("no_telegram");
    expect(transport.sent.length).toBe(0);
    // Marker must be cleared so we don't re-process it forever.
    expect(await readPendingUpdate(pendingPath)).toBeUndefined();
  });

  test("malformed marker → treated as no_marker, file left alone", async () => {
    await writeFile(pendingPath, "{not json", "utf8");
    const transport = new FakeTransport();
    const r = await notifyPostRestartIfPending({
      config: baseConfig(),
      currentVersion: "1.0.99",
      transport,
      pendingPath,
    });
    expect(r.status).toBe("no_marker");
    expect(transport.sent.length).toBe(0);
    // Garbage file still on disk — operator can inspect / remove manually.
    const stillThere = await readFile(pendingPath, "utf8").catch(
      () => "missing",
    );
    expect(stillThere).toContain("{not json");
  });

  test("personas-only setup (no default block) → adminAccount drives notify, status = success_notified", async () => {
    // Simulates `run.ts` on a personas-only config: no
    // `[channels.telegram]`, but the caller passes the admin listener's
    // account so the post-restart message still goes out.
    const cfg = baseConfig();
    cfg.channels.telegram = undefined;
    cfg.channels.telegramPersonas = {
      miles: { token: "miles-tok", pollTimeoutS: 30, allowedUserIds: [42, 99] },
    };
    await writePendingUpdate(
      {
        targetVersion: "1.0.99",
        targetTag: "v1.0.99",
        previousVersion: "1.0.42",
        writtenAt: "2026-05-11T00:00:00Z",
      },
      pendingPath,
    );
    const transport = new FakeTransport();
    const r = await notifyPostRestartIfPending({
      config: cfg,
      currentVersion: "1.0.99",
      transport,
      pendingPath,
      adminAccount: cfg.channels.telegramPersonas.miles,
    });
    expect(r.status).toBe("success_notified");
    // Broadcast to adminAccount.allowedUserIds, NOT no-op.
    expect(transport.sent.map((s) => s.chatId).sort()).toEqual(["42", "99"]);
    expect(await readPendingUpdate(pendingPath)).toBeUndefined();
  });

  test("hybrid marker with persona → notify uses persona account, not default account", async () => {
    const cfg = baseConfig();
    cfg.channels.telegram = {
      token: "default-tok",
      pollTimeoutS: 30,
      allowedUserIds: [1, 2],
    };
    cfg.channels.telegramPersonas = {
      miles: {
        token: "miles-tok",
        pollTimeoutS: 30,
        allowedUserIds: [42, 99],
      },
    };
    await writePendingUpdate(
      {
        targetVersion: "1.0.99",
        targetTag: "v1.0.99",
        chatId: 4242,
        persona: "miles",
        previousVersion: "1.0.42",
        writtenAt: "2026-05-11T00:00:00Z",
      },
      pendingPath,
    );

    const createdForTokens: string[] = [];
    const transport = new FakeTransport();
    const r = await notifyPostRestartIfPending({
      config: cfg,
      currentVersion: "1.0.99",
      pendingPath,
      adminAccount: cfg.channels.telegram,
      createTransport: (account) => {
        createdForTokens.push(account.token);
        return transport;
      },
    });

    expect(r.status).toBe("success_notified");
    expect(createdForTokens).toEqual(["miles-tok"]);
    expect(transport.sent.map((s) => s.chatId)).toEqual(["4242"]);
    expect(await readPendingUpdate(pendingPath)).toBeUndefined();
  });

  test("adminAccount wins over config.channels.telegram for recipients", async () => {
    // Hybrid config (both default + personas) should still let the
    // caller pick which account drives recipients. Guards against a
    // future refactor accidentally reading `tg.allowedUserIds`.
    const cfg = baseConfig();
    cfg.channels.telegram = {
      token: "default-tok",
      pollTimeoutS: 30,
      allowedUserIds: [1, 2],
    };
    await writePendingUpdate(
      {
        targetVersion: "1.0.99",
        targetTag: "v1.0.99",
        previousVersion: "1.0.42",
        writtenAt: "2026-05-11T00:00:00Z",
      },
      pendingPath,
    );
    const transport = new FakeTransport();
    const r = await notifyPostRestartIfPending({
      config: cfg,
      currentVersion: "1.0.99",
      transport,
      pendingPath,
      adminAccount: {
        token: "admin-tok",
        pollTimeoutS: 30,
        allowedUserIds: [777],
      },
    });
    expect(r.status).toBe("success_notified");
    expect(transport.sent.map((s) => s.chatId)).toEqual(["777"]);
  });
});

// ---------------------------------------------------------------------------
// PhantomChat /update routing (regression)
//
// The bug: `/update` typed in the PhantomChat PWA replied "✅ Updated to vX"
// on Telegram instead of back in PhantomChat. Root cause — the marker only
// carried a numeric Telegram chatId; a PhantomChat conversation id is a hex
// pubkey, so `Number(hex)` → NaN → serialized null → the Telegram notify fell
// through to broadcasting to the allowlist. These tests lock in the fix:
//   1. the marker carries the channel-neutral `conversation` key;
//   2. the Telegram notify DEFERS (doesn't send, doesn't clear) a PhantomChat
//      marker so it can't leak onto Telegram;
//   3. the PhantomChat notifier sends the confirmation back to the originating
//      pubkey over its own transport and clears the marker.
// ---------------------------------------------------------------------------

const PC_HEX =
  "abc123def456abc123def456abc123def456abc123def456abc123def4560000";

/** Minimal fake of the PhantomChat transport seam — records DM sends. */
class FakePhantomchatTransport {
  sent: Array<{ to: string; text: string }> = [];
  shouldThrow = false;
  async sendMessage(conversationId: string, text: string): Promise<void> {
    if (this.shouldThrow) throw new Error("relay down");
    this.sent.push({ to: conversationId, text });
  }
}

describe("pendingUpdateChannel", () => {
  test("legacy marker without conversation → telegram", () => {
    expect(pendingUpdateChannel({})).toBe("telegram");
  });
  test("telegram: prefix → telegram", () => {
    expect(pendingUpdateChannel({ conversation: "telegram:42" })).toBe(
      "telegram",
    );
  });
  test("phantomchat: prefix → phantomchat", () => {
    expect(
      pendingUpdateChannel({ conversation: `phantomchat:${PC_HEX}` }),
    ).toBe("phantomchat");
  });
});

describe("runUpdateFlow persists the conversation key into the marker", () => {
  test("PhantomChat-origin /update writes conversation + persona, NaN chatId", async () => {
    const r = await runUpdateFlow({
      config: baseConfig(),
      currentVersion: "1.0.42",
      // commands.ts does Number(ctx.chatId); for a hex pubkey that's NaN —
      // exactly the case that used to silently fall back to Telegram.
      chatId: Number(PC_HEX),
      conversation: `phantomchat:${PC_HEX}`,
      persona: "lena",
      fetchImpl: fakeReleaseFetch(),
      serviceControl: fakeSvc().svc,
      runUpdateImpl: fakeRunUpdate(0),
      pendingPath,
      lastNotifiedPath: lastNotifiedPathLocal,
      procPlatform: "linux",
      procArch: "x64",
    });
    expect(r.restart).toBeDefined();
    const marker = await readPendingUpdate(pendingPath);
    expect(marker?.conversation).toBe(`phantomchat:${PC_HEX}`);
    expect(marker?.persona).toBe("lena");
  });
});

describe("notifyPostRestartIfPending defers PhantomChat markers", () => {
  test("a PhantomChat marker is NOT sent to Telegram and is NOT cleared", async () => {
    await writePendingUpdate(
      {
        targetVersion: "1.0.99",
        targetTag: "v1.0.99",
        conversation: `phantomchat:${PC_HEX}`,
        persona: "lena",
        previousVersion: "1.0.42",
        writtenAt: "2026-06-28T00:00:00Z",
      },
      pendingPath,
    );
    const transport = new FakeTransport();
    const r = await notifyPostRestartIfPending({
      config: baseConfig(), // Telegram IS configured — the bug's trigger
      currentVersion: "1.0.99",
      transport,
      pendingPath,
    });
    // The regression: must NOT broadcast on Telegram…
    expect(r.status).toBe("deferred_other_channel");
    expect(transport.sent.length).toBe(0);
    // …and must leave the marker for the PhantomChat path to claim.
    expect(await readPendingUpdate(pendingPath)).not.toBeUndefined();
  });
});

describe("notifyPhantomchatPostRestart", () => {
  test("matching persona + success → DMs the originating pubkey, clears marker", async () => {
    await writePendingUpdate(
      {
        targetVersion: "1.0.99",
        targetTag: "v1.0.99",
        conversation: `phantomchat:${PC_HEX}`,
        persona: "lena",
        previousVersion: "1.0.42",
        writtenAt: "2026-06-28T00:00:00Z",
      },
      pendingPath,
    );
    const transport = new FakePhantomchatTransport();
    const r = await notifyPhantomchatPostRestart({
      persona: "lena",
      transport,
      currentVersion: "1.0.99",
      pendingPath,
    });
    expect(r.status).toBe("success_notified");
    expect(transport.sent.length).toBe(1);
    // Sent to the bare hex pubkey (no "phantomchat:" prefix).
    expect(transport.sent[0]!.to).toBe(PC_HEX);
    expect(transport.sent[0]!.text).toContain("✅");
    expect(transport.sent[0]!.text).toContain("v1.0.99");
    expect(await readPendingUpdate(pendingPath)).toBeUndefined();
  });

  test("version mismatch → failure DM, marker cleared", async () => {
    await writePendingUpdate(
      {
        targetVersion: "1.0.99",
        targetTag: "v1.0.99",
        conversation: `phantomchat:${PC_HEX}`,
        persona: "lena",
        previousVersion: "1.0.42",
        writtenAt: "2026-06-28T00:00:00Z",
      },
      pendingPath,
    );
    const transport = new FakePhantomchatTransport();
    const r = await notifyPhantomchatPostRestart({
      persona: "lena",
      transport,
      currentVersion: "1.0.42", // didn't take
      pendingPath,
    });
    expect(r.status).toBe("failure_notified");
    expect(transport.sent[0]!.text).toContain("⚠️");
    expect(await readPendingUpdate(pendingPath)).toBeUndefined();
  });

  test("different persona → leaves marker untouched (the right listener claims it)", async () => {
    await writePendingUpdate(
      {
        targetVersion: "1.0.99",
        targetTag: "v1.0.99",
        conversation: `phantomchat:${PC_HEX}`,
        persona: "lena",
        previousVersion: "1.0.42",
        writtenAt: "2026-06-28T00:00:00Z",
      },
      pendingPath,
    );
    const transport = new FakePhantomchatTransport();
    const r = await notifyPhantomchatPostRestart({
      persona: "kai", // a different persona's listener
      transport,
      currentVersion: "1.0.99",
      pendingPath,
    });
    expect(r.status).toBe("not_this_persona");
    expect(transport.sent.length).toBe(0);
    // Marker stays so Lena's listener can still confirm it.
    expect(await readPendingUpdate(pendingPath)).not.toBeUndefined();
  });

  test("a Telegram-origin marker is ignored here (not_phantomchat), left for the Telegram path", async () => {
    await writePendingUpdate(
      {
        targetVersion: "1.0.99",
        targetTag: "v1.0.99",
        conversation: "telegram:42",
        chatId: 42,
        previousVersion: "1.0.42",
        writtenAt: "2026-06-28T00:00:00Z",
      },
      pendingPath,
    );
    const transport = new FakePhantomchatTransport();
    const r = await notifyPhantomchatPostRestart({
      persona: "lena",
      transport,
      currentVersion: "1.0.99",
      pendingPath,
    });
    expect(r.status).toBe("not_phantomchat");
    expect(transport.sent.length).toBe(0);
    expect(await readPendingUpdate(pendingPath)).not.toBeUndefined();
  });

  test("send failure → marker preserved for a later retry", async () => {
    await writePendingUpdate(
      {
        targetVersion: "1.0.99",
        targetTag: "v1.0.99",
        conversation: `phantomchat:${PC_HEX}`,
        persona: "lena",
        previousVersion: "1.0.42",
        writtenAt: "2026-06-28T00:00:00Z",
      },
      pendingPath,
    );
    const transport = new FakePhantomchatTransport();
    transport.shouldThrow = true;
    const r = await notifyPhantomchatPostRestart({
      persona: "lena",
      transport,
      currentVersion: "1.0.99",
      pendingPath,
    });
    // Still reports the would-be outcome, but keeps the marker (one recipient,
    // so a retry can't double-spam).
    expect(r.status).toBe("success_notified");
    expect(await readPendingUpdate(pendingPath)).not.toBeUndefined();
  });

  test("no marker → no-op", async () => {
    const transport = new FakePhantomchatTransport();
    const r = await notifyPhantomchatPostRestart({
      persona: "lena",
      transport,
      currentVersion: "1.0.99",
      pendingPath,
    });
    expect(r.status).toBe("no_marker");
    expect(transport.sent.length).toBe(0);
  });
});
