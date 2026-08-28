/**
 * The Channels flow: every cancel leaves the config alone, and a token is
 * only written once Telegram has answered to it.
 */
import { describe, expect, test } from "bun:test";

import {
  configureTelegram,
  type ChannelsDeps,
  type ChannelsQuestions,
} from "../src/tui/channelsFlow.ts";

const GOOD = "12345678:AAeeFFggHHiiJJkkLLmmNNooPPqqRRssTT1";

function deps(over: Partial<ChannelsDeps> = {}): ChannelsDeps & {
  saved: { token: string; allowedUserIds: number[] }[];
} {
  const saved: { token: string; allowedUserIds: number[] }[] = [];
  return {
    saved,
    validateToken: async () => ({ ok: true, username: "bot", id: 1 }),
    save: async (i) => void saved.push(i),
    targetPath: "/tmp/config.toml",
    ...over,
  };
}

function ask(answers: {
  choose?: (string | undefined)[];
  value?: (string | undefined)[];
  confirm?: boolean[];
}): ChannelsQuestions {
  const c = [...(answers.choose ?? [])];
  const v = [...(answers.value ?? [])];
  const y = [...(answers.confirm ?? [])];
  return {
    choose: async () => c.shift(),
    value: async () => v.shift(),
    confirm: async () => y.shift() ?? false,
  };
}

describe("channels flow", () => {
  test("first-time setup validates then saves", async () => {
    const d = deps();
    const notice = await configureTelegram(
      "robbie",
      ask({ value: [GOOD, "111, 222"] }),
      d,
    );
    expect(d.saved).toEqual([{ token: GOOD, allowedUserIds: [111, 222] }]);
    expect(notice).toContain("saved");
  });

  test("a rejected token is never written", async () => {
    const d = deps({
      validateToken: async () => ({ ok: false, error: "401 Unauthorized" }),
    });
    const notice = await configureTelegram("robbie", ask({ value: [GOOD] }), d);
    expect(d.saved).toEqual([]);
    expect(notice).toContain("401");
  });

  test("esc at the allowlist leaves the config untouched", async () => {
    const d = deps();
    const notice = await configureTelegram(
      "robbie",
      ask({ value: [GOOD, undefined] }),
      d,
    );
    expect(d.saved).toEqual([]);
    expect(notice).toBe("channels unchanged");
  });

  test("emptying the allowlist needs an explicit yes", async () => {
    const d = deps();
    const declined = await configureTelegram(
      "robbie",
      ask({ value: [GOOD, ""], confirm: [false] }),
      d,
    );
    expect(d.saved).toEqual([]);
    expect(declined).toBe("channels unchanged");

    const d2 = deps();
    const notice = await configureTelegram(
      "robbie",
      ask({ value: [GOOD, ""], confirm: [true] }),
      d2,
    );
    expect(d2.saved).toEqual([{ token: GOOD, allowedUserIds: [] }]);
    expect(notice).toContain("OPEN");
  });

  test("existing config: 'Allowed users' keeps the token", async () => {
    const d = deps({
      existing: { token: "old:token", allowedUserIds: [7] },
      validateToken: async () => {
        throw new Error("must not validate — token was kept");
      },
    });
    await configureTelegram(
      "robbie",
      ask({ choose: ["users"], value: ["7, 8"] }),
      d,
    );
    expect(d.saved).toEqual([{ token: "old:token", allowedUserIds: [7, 8] }]);
  });

  test("existing config: esc on the action menu changes nothing", async () => {
    const d = deps({ existing: { token: "old:token", allowedUserIds: [7] } });
    expect(
      await configureTelegram("robbie", ask({ choose: [undefined] }), d),
    ).toBe("channels unchanged");
    expect(d.saved).toEqual([]);
  });
});
