/**
 * Tests for the Matrix branch of `phantombot notify` (issue #154).
 *
 * Verifies channel dispatch off default_channel and the Matrix-specific
 * account/allowlist resolution, with an injected `MatrixNotifySender` so no
 * SDK / network / crypto is touched.
 */

import { describe, expect, test } from "bun:test";

import { runNotify } from "../src/cli/notify.ts";
import {
  resolveOrCreateDm,
  type DmResolverClient,
  type MatrixNotifySender,
} from "../src/cli/notify-matrix.ts";
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

/**
 * Regression tests for the DM resolver (PR #179 review): a freshly created DM
 * on an E2EE account MUST be provisioned with `m.room.encryption` initial
 * state, or matrix-bot-sdk sends the first proactive notify plaintext. We also
 * persist `m.direct` so the next notify reuses the room.
 */
describe("resolveOrCreateDm", () => {
  function fakeClient(direct: Record<string, unknown> | undefined) {
    const created: Array<Record<string, unknown>> = [];
    const accountWrites: Array<{ type: string; content: unknown }> = [];
    let store = direct;
    const client: DmResolverClient = {
      getAccountData: async (type: string) =>
        type === "m.direct" ? store : undefined,
      setAccountData: async (type: string, content: unknown) => {
        if (type === "m.direct") store = content as Record<string, unknown>;
        accountWrites.push({ type, content });
      },
      createRoom: async (opts: Record<string, unknown>) => {
        created.push(opts);
        return "!new:hs";
      },
    };
    return { client, created, accountWrites, getStore: () => store };
  }

  test("reuses the existing DM room from m.direct without creating one", async () => {
    const { client, created } = fakeClient({ "@a:hs": ["!existing:hs"] });
    const room = await resolveOrCreateDm(client, "@a:hs", true);
    expect(room).toBe("!existing:hs");
    expect(created).toHaveLength(0);
  });

  test("E2EE: creates the DM with m.room.encryption initial state", async () => {
    const { client, created } = fakeClient({});
    const room = await resolveOrCreateDm(client, "@a:hs", true);
    expect(room).toBe("!new:hs");
    expect(created).toHaveLength(1);
    const opts = created[0]!;
    expect(opts.preset).toBe("trusted_private_chat");
    expect(opts.is_direct).toBe(true);
    expect(opts.invite).toEqual(["@a:hs"]);
    expect(opts.initial_state).toEqual([
      {
        type: "m.room.encryption",
        state_key: "",
        content: { algorithm: "m.megolm.v1.aes-sha2" },
      },
    ]);
  });

  test("non-E2EE: creates the DM with no encryption initial state", async () => {
    const { client, created } = fakeClient({});
    await resolveOrCreateDm(client, "@a:hs", false);
    expect(created[0]!.initial_state).toBeUndefined();
  });

  test("persists the new room into m.direct for reuse", async () => {
    const { client, getStore } = fakeClient({ "@b:hs": ["!other:hs"] });
    await resolveOrCreateDm(client, "@a:hs", true);
    expect(getStore()).toEqual({
      "@b:hs": ["!other:hs"],
      "@a:hs": ["!new:hs"],
    });
  });

  test("a failed m.direct write does not block returning the room", async () => {
    const created: Array<Record<string, unknown>> = [];
    const client: DmResolverClient = {
      getAccountData: async () => ({}),
      setAccountData: async () => {
        throw new Error("network");
      },
      createRoom: async (opts) => {
        created.push(opts);
        return "!new:hs";
      },
    };
    const room = await resolveOrCreateDm(client, "@a:hs", true);
    expect(room).toBe("!new:hs");
    expect(created).toHaveLength(1);
  });
});
