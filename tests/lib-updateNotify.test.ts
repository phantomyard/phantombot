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
  notifyPostRestartIfPending,
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
  sent: Array<{ chatId: number; text: string }> = [];
  sendMessageImpl?: (chatId: number, text: string) => Promise<void>;
  async getUpdates(): Promise<{
    updates: TelegramMessage[];
    nextOffset: number;
  }> {
    return { updates: [], nextOffset: 0 };
  }
  async ackUpdates(): Promise<void> {}
  async sendMessage(chatId: number, text: string): Promise<void> {
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
      procPlatform: "win32",
      procArch: "x64",
    });
    expect(r.reply).toContain("can't self-update");
    expect(r.reply).toContain("platform=win32");
    expect(r.restart).toBeUndefined();
    expect(runUpdateCalled).toBe(false);
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
      procPlatform: "win32",
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
      if (chatId === 99) throw new Error("rate limited");
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
    expect(transport.sent[0]!.chatId).toBe(42);
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
    expect(transport.sent.map((s) => s.chatId).sort()).toEqual([42, 99]);
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
});
