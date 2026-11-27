/**
 * The PhantomChat guide a phantom is given must stay true to the code it
 * describes. These pin the claims most likely to drift: the handoff budget,
 * the wake rules and the CLI that prints the long form.
 */
import { describe, expect, spyOn, test } from "bun:test";
import phantomchatCommand from "../src/cli/phantomchat.ts";
import {
  PHANTOMCHAT_GUIDE,
  PHANTOMCHAT_INSTRUCTION,
  PHANTOMCHAT_TEAM_INSTRUCTION,
} from "../src/channels/core/prompts.ts";
import {
  decideGroupReply,
  matchAtMentions,
  matchPersonaNames,
  MAX_WHOLE_HANDOFF_BYTES,
  PHANTOM_HANDOFF_BUDGET,
} from "../src/channels/core/routing.ts";
import { unmatchedMentions } from "../src/channels/core/groupContext.ts";
import { BACKFILL_POLL_WINDOW_SEC, GROUP_HISTORY_WINDOW_SEC } from "../src/channels/phantomchat/channel.ts";

describe("phantomchat guide", () => {
  test("states the real handoff budget", () => {
    for (const text of [PHANTOMCHAT_TEAM_INSTRUCTION, PHANTOMCHAT_GUIDE]) {
      expect(text).toContain(`budget of ${PHANTOM_HANDOFF_BUDGET} per group`);
    }
  });

  test("states the whole-handoff size cap", () => {
    for (const text of [PHANTOMCHAT_TEAM_INSTRUCTION, PHANTOMCHAT_GUIDE]) {
      expect(text).toContain(`${MAX_WHOLE_HANDOFF_BYTES} bytes`);
    }
  });

  test("restart claims match the history and catch-up windows", () => {
    // "~90 seconds" can still run a turn; history reaches 48 hours.
    expect(BACKFILL_POLL_WINDOW_SEC).toBe(90);
    expect(GROUP_HISTORY_WINDOW_SEC).toBe(48 * 3600);
    for (const text of [PHANTOMCHAT_TEAM_INSTRUCTION, PHANTOMCHAT_GUIDE]) {
      expect(text).toContain("~90 seconds");
      expect(text).not.toContain("never runs a turn");
    }
    expect(PHANTOMCHAT_GUIDE).toContain("48 hours");
  });

  test("an unmatched mention is not always reported", () => {
    const members = [
      { name: "Kai", kind: "phantom" as const },
      { name: "Andrew", kind: "human" as const },
    ];
    // Positive control: a direct call to nobody IS reported.
    expect(unmatchedMentions("@Nobody please review", members as any)).toEqual(["Nobody"]);
    // Quoted and mid-sentence calls get no notice, as the guide warns.
    expect(unmatchedMentions("> @Nobody please review", members as any)).toEqual([]);
    expect(unmatchedMentions("Please ask @Nobody to review this.", members as any)).toEqual([]);
    // A nameless member silences every notice.
    expect(unmatchedMentions("@Nobody please review", [...members, { name: "", kind: "phantom" }] as any)).toEqual([]);
    for (const text of [PHANTOMCHAT_TEAM_INSTRUCTION, PHANTOMCHAT_GUIDE]) {
      expect(text).not.toContain("you will be told");
      expect(text).toMatch(/not\s+always/);
    }
  });

  test("wake rules match routing", () => {
    // "anywhere in the message, even inside code or quotes"
    expect(matchAtMentions("done.\n\n`@Kai` please review", ["kai"])).toEqual(["kai"]);
    expect(matchAtMentions("> @kai over to you", ["kai"])).toEqual(["kai"]);
    // "Naming without @ wakes nobody"
    expect(matchAtMentions("Kai approved", ["kai"])).toEqual([]);
    // Humans: naming wakes, with or without "@"
    expect(matchPersonaNames("lena, status?", ["lena"])).toEqual(["lena"]);
    // "a human message that names no phantom goes to whoever was named last"
    expect(decideGroupReply({ self: "lena", matched: [], lastAddressed: ["lena"] }).reply).toBe(true);
    expect(decideGroupReply({ self: "lena", matched: [], lastAddressed: [] }).reply).toBe(false);
  });

  test("the short form points at the long form, and stays short", () => {
    expect(PHANTOMCHAT_INSTRUCTION).toContain("phantombot phantomchat --guide");
    // It rides on every turn: keep it small.
    expect(PHANTOMCHAT_INSTRUCTION.length + PHANTOMCHAT_TEAM_INSTRUCTION.length).toBeLessThan(2500);
  });

  test("`phantombot phantomchat --guide` prints the guide and touches nothing", async () => {
    const written: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      await (phantomchatCommand as any).run({ args: { guide: true }, rawArgs: [], cmd: phantomchatCommand });
    } finally {
      spy.mockRestore();
    }
    expect(written.join("")).toBe(PHANTOMCHAT_GUIDE);
  });
});
