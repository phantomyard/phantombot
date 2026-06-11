/**
 * Tests for the Matrix branch of `phantombot notify` (issue #154).
 *
 * Verifies channel dispatch off default_channel and the Matrix-specific
 * account/allowlist resolution, with an injected `MatrixNotifySender` so no
 * SDK / network / crypto is touched.
 */

import { describe, expect, test } from "bun:test";

import { runNotify } from "../src/cli/notify.ts";
import type { MatrixNotifySender } from "../src/cli/notify-matrix.ts";
import type { Config } from "../src/config.ts";

class CaptureStream {
  text = "";
  write(s: string): boolean {
    this.text += s;
    return true;
  }
}

function matrixConfig(allowed: string[]): Config {
  return {
    defaultChannel: "matrix",
    channels: {
      matrix: {
        homeserver: "https://hs",
        userId: "@bot:hs",
        deviceId: "DEV",
        accessToken: "tok",
        allowedUserIds: allowed,
      },
    },
  } as unknown as Config;
}

describe("runNotify — matrix channel", () => {
  test("routes off default_channel and sends to each allow-listed MXID", async () => {
    const sends: Array<{ mxid: string; message: string }> = [];
    const sender: MatrixNotifySender = {
      send: async ({ mxid, message }) => {
        sends.push({ mxid, message });
      },
    };
    const out = new CaptureStream();
    const code = await runNotify({
      config: matrixConfig(["@andrew:hs", "@robbie:hs"]),
      message: "heads up",
      matrixSender: sender,
      out: out as unknown as NodeJS.WriteStream,
    });
    expect(code).toBe(0);
    expect(sends).toEqual([
      { mxid: "@andrew:hs", message: "heads up" },
      { mxid: "@robbie:hs", message: "heads up" },
    ]);
    expect(out.text).toContain("matrix recipients");
  });

  test("refuses to broadcast when the matrix allowlist is empty", async () => {
    const err = new CaptureStream();
    const code = await runNotify({
      config: matrixConfig([]),
      message: "hi",
      matrixSender: { send: async () => {} },
      err: err as unknown as NodeJS.WriteStream,
    });
    expect(code).toBe(2);
    expect(err.text).toContain("allowed_user_ids");
  });

  test("errors when matrix is the default channel but unconfigured", async () => {
    const err = new CaptureStream();
    const code = await runNotify({
      config: { defaultChannel: "matrix", channels: {} } as unknown as Config,
      message: "hi",
      err: err as unknown as NodeJS.WriteStream,
    });
    expect(code).toBe(2);
    expect(err.text).toContain("matrix is not configured");
  });

  test("explicit channel:matrix overrides a telegram default", async () => {
    const sends: string[] = [];
    const cfg = matrixConfig(["@a:hs"]);
    (cfg as { defaultChannel?: string }).defaultChannel = "telegram";
    const out = new CaptureStream();
    const code = await runNotify({
      config: cfg,
      message: "x",
      channel: "matrix",
      matrixSender: { send: async ({ mxid }) => void sends.push(mxid) },
      out: out as unknown as NodeJS.WriteStream,
    });
    expect(code).toBe(0);
    expect(sends).toEqual(["@a:hs"]);
  });
});
