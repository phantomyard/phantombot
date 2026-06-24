/**
 * Unit tests for the coding-brain auto-swap (src/lib/coderSwap.ts):
 *   - scoreCodingIntent: CRS-style weighted scorer (distinct dedup, EN/ES/NL)
 *   - resolveSwapModel: override precedence + threshold decision
 *   - the persistent per-conversation /coder override store
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCoderSwapRequest,
  clearCoderSwapOverride,
  CODER_SWAP_THRESHOLD,
  coderSwapStatePath,
  getCoderSwapOverride,
  normalizeCoderSwapRequest,
  resolveSwapModel,
  scoreCodingIntent,
  setCoderSwapOverride,
} from "../src/lib/coderSwap.ts";

describe("scoreCodingIntent — trips (>= threshold)", () => {
  const cases: Array<[string, string]> = [
    ["GitHub PR URL", "take a look at https://github.com/phantomyard/phantombot/pull/195"],
    ["GitLab MR URL", "review gitlab.com/acme/app/-/merge_requests/42 please"],
    ["Bitbucket PR URL", "see bitbucket.org/x/y/pull-requests/7"],
    ["pull request phrase", "can you open a pull request for this"],
    ["code review phrase", "do a code review on the auth module"],
    ["EN: refactor + code + src", "refactor the auth code in src"],
    ["ES: revisar + código + src", "puedes revisar el código en src"],
    ["NL: nakijken + code + repo", "kun je de code in deze repo nakijken"],
    ["bugfix + file path", "fix the bug in src/parser.ts"],
    ["codebase + refactor", "big refactor across the whole codebase"],
  ];
  for (const [name, text] of cases) {
    test(name, () => {
      expect(scoreCodingIntent(text).score).toBeGreaterThanOrEqual(
        CODER_SWAP_THRESHOLD,
      );
    });
  }
});

describe("scoreCodingIntent — stays below threshold (chat)", () => {
  const cases: Array<[string, string]> = [
    ["pull up calendar", "pull up my calendar for tomorrow"],
    ["bank branch", "where's the nearest bank branch"],
    ["dress code", "what's the dress code for the dinner"],
    ["single weak word: git", "what is git anyway"],
    ["plain chat", "how's the weather looking this weekend"],
    ["one strong word alone", "show me the repo list"],
    // Borderline: a single-function bug mention is small inline work (fix+bug
    // dedup to one signal + function = 2), so it deliberately stays on primary.
    ["single-function bugfix", "fix the bug in the parse function"],
  ];
  for (const [name, text] of cases) {
    test(name, () => {
      expect(scoreCodingIntent(text).score).toBeLessThan(CODER_SWAP_THRESHOLD);
    });
  }
});

describe("scoreCodingIntent — mechanics", () => {
  test("distinct dedup: a repeated signal counts once", () => {
    const once = scoreCodingIntent("code");
    const many = scoreCodingIntent("code code code code code");
    expect(many.score).toBe(once.score);
    expect(many.hits).toEqual(once.hits);
  });

  test("empty input scores zero", () => {
    expect(scoreCodingIntent("").score).toBe(0);
    expect(scoreCodingIntent("   ").score).toBe(0);
  });

  test("a hard trigger trips on its own", () => {
    expect(scoreCodingIntent("merge request").score).toBeGreaterThanOrEqual(
      CODER_SWAP_THRESHOLD,
    );
  });

  test("accented words are bounded correctly (Unicode)", () => {
    // 'código' must match as a whole word, not partially or not at all.
    expect(scoreCodingIntent("revisar el código").hits).toContain("code");
  });
});

describe("resolveSwapModel", () => {
  const PRIMARY = "gpt-5.2";
  const CODING = "glm-5.3";

  test("no coding model → never swaps", () => {
    const d = resolveSwapModel({
      text: "refactor the whole codebase in src",
      primaryModel: PRIMARY,
      codingModel: undefined,
    });
    expect(d.swapped).toBe(false);
    expect(d.model).toBe(PRIMARY);
  });

  test("score trips → coding model", () => {
    const d = resolveSwapModel({
      text: "refactor the auth code in src",
      primaryModel: PRIMARY,
      codingModel: CODING,
    });
    expect(d.swapped).toBe(true);
    expect(d.model).toBe(CODING);
  });

  test("score below threshold → primary", () => {
    const d = resolveSwapModel({
      text: "what's on my calendar today",
      primaryModel: PRIMARY,
      codingModel: CODING,
    });
    expect(d.swapped).toBe(false);
    expect(d.model).toBe(PRIMARY);
  });

  test("override:on wins over a low score", () => {
    const d = resolveSwapModel({
      text: "hi there",
      override: "on",
      primaryModel: PRIMARY,
      codingModel: CODING,
    });
    expect(d.swapped).toBe(true);
    expect(d.model).toBe(CODING);
  });

  test("override:off wins over a high score", () => {
    const d = resolveSwapModel({
      text: "refactor the whole codebase in src",
      override: "off",
      primaryModel: PRIMARY,
      codingModel: CODING,
    });
    expect(d.swapped).toBe(false);
    expect(d.model).toBe(PRIMARY);
  });

  test("custom threshold is honored", () => {
    const text = "show me the repo"; // one strong signal (2)
    expect(
      resolveSwapModel({ text, primaryModel: PRIMARY, codingModel: CODING, threshold: 2 }).swapped,
    ).toBe(true);
    expect(
      resolveSwapModel({ text, primaryModel: PRIMARY, codingModel: CODING, threshold: 3 }).swapped,
    ).toBe(false);
  });
});

describe("normalizeCoderSwapRequest", () => {
  test("on/off/default + synonyms", () => {
    expect(normalizeCoderSwapRequest("on")).toBe("on");
    expect(normalizeCoderSwapRequest("force")).toBe("on");
    expect(normalizeCoderSwapRequest("off")).toBe("off");
    expect(normalizeCoderSwapRequest("no")).toBe("off");
    expect(normalizeCoderSwapRequest("default")).toBe("default");
    expect(normalizeCoderSwapRequest("auto")).toBe("default");
    expect(normalizeCoderSwapRequest("")).toBe("default");
  });
  test("rejects unknown", () => {
    expect(normalizeCoderSwapRequest("maybe")).toBeUndefined();
  });
});

describe("override store", () => {
  const SAVED = process.env.PHANTOMBOT_CODER_SWAP_STATE;
  let dir: string;
  const who = { persona: "lena", conversation: "telegram:1" };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "phantombot-coder-swap-"));
    process.env.PHANTOMBOT_CODER_SWAP_STATE = join(dir, "state.json");
  });
  afterEach(async () => {
    if (SAVED === undefined) delete process.env.PHANTOMBOT_CODER_SWAP_STATE;
    else process.env.PHANTOMBOT_CODER_SWAP_STATE = SAVED;
    await rm(dir, { recursive: true, force: true });
  });

  test("path honors the env override", () => {
    expect(coderSwapStatePath()).toBe(join(dir, "state.json"));
  });

  test("unset → undefined", async () => {
    expect(await getCoderSwapOverride(who)).toBeUndefined();
  });

  test("set/get/clear round-trip", async () => {
    await setCoderSwapOverride({ ...who, mode: "on" });
    expect(await getCoderSwapOverride(who)).toBe("on");
    await setCoderSwapOverride({ ...who, mode: "off" });
    expect(await getCoderSwapOverride(who)).toBe("off");
    await clearCoderSwapOverride(who);
    expect(await getCoderSwapOverride(who)).toBeUndefined();
  });

  test("applyCoderSwapRequest: default clears", async () => {
    await applyCoderSwapRequest({ ...who, request: "on" });
    expect(await getCoderSwapOverride(who)).toBe("on");
    await applyCoderSwapRequest({ ...who, request: "default" });
    expect(await getCoderSwapOverride(who)).toBeUndefined();
  });

  test("overrides are scoped per persona+conversation", async () => {
    await setCoderSwapOverride({ ...who, mode: "on" });
    expect(
      await getCoderSwapOverride({ persona: "kai", conversation: "telegram:1" }),
    ).toBeUndefined();
    expect(
      await getCoderSwapOverride({ persona: "lena", conversation: "telegram:2" }),
    ).toBeUndefined();
  });
});
