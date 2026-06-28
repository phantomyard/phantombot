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
  analyzeTurn,
  applyCoderSwapRequest,
  clearCoderSwapOverride,
  CODER_SWAP_THRESHOLD,
  coderSwapStatePath,
  CONTEXT_DEFAULTS,
  getCoderSwapOverride,
  normalizeCoderSwapRequest,
  resolveSwapModel,
  scoreCodingContext,
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

describe("analyzeTurn — HARD vs soft split", () => {
  test("a bare PR URL is HARD with no soft weight", () => {
    const t = analyzeTurn("see https://example.com/x/y/pull/9");
    expect(t.hard).toBe(true);
    expect(t.soft).toBe(0);
  });

  test("soft signals accumulate without tripping HARD", () => {
    const t = analyzeTurn("refactor the auth code in src");
    expect(t.hard).toBe(false);
    expect(t.soft).toBeGreaterThanOrEqual(CONTEXT_DEFAULTS.saturation);
  });

  test("scoreCodingIntent folds HARD back into the flat sum", () => {
    expect(scoreCodingIntent("merge request").score).toBeGreaterThanOrEqual(100);
  });
});

describe("scoreCodingContext — context window", () => {
  const code = "refactor the auth code in src"; // soft >= saturation (a coding turn)
  const chat = "what's for dinner tonight"; // soft 0
  const followup = "what about the error handling in the second commit"; // weak

  test("single coding message swaps (legacy parity at soft >= 3)", () => {
    expect(scoreCodingContext([code]).swap).toBe(true);
  });

  test("single weak follow-up alone does NOT swap", () => {
    expect(scoreCodingContext([followup]).swap).toBe(false);
  });

  test("weak follow-up swaps when it follows a coding turn (in context)", () => {
    const alone = scoreCodingContext([followup]);
    const inContext = scoreCodingContext([code, code, followup]);
    expect(alone.swap).toBe(false);
    expect(inContext.swap).toBe(true);
  });

  test("HARD carries through weak follow-ups, then releases", () => {
    const pr = "please review this pull request github.com/x/y/pull/12";
    // age 0..3 after the PR: still carried (0.5^3 = 0.125 >= floor 0.1)
    expect(scoreCodingContext([pr, followup, followup, followup]).swap).toBe(true);
    // age 4: 0.5^4 = 0.0625 < floor 0.1 → released, and weak chat can't hold it
    expect(
      scoreCodingContext([pr, chat, chat, chat, chat]).swap,
    ).toBe(false);
  });

  test("flip-back: chat after a coding session returns to primary", () => {
    // a stuffed window of old coding turns must not pin us once talk moves on
    expect(scoreCodingContext([code, code, code, chat]).swap).toBe(false);
  });

  test("evidence prior: 1 turn is more skeptical than many (k scaling)", () => {
    // a borderline turn (soft 2 = "show me the repo") never trips alone...
    const weakCode = "show me the repo";
    expect(scoreCodingContext([weakCode]).swap).toBe(false);
    // ...but a sustained run of the same borderline signal builds enough
    // decayed evidence to clear the ratio bar as k shrinks relative to weight.
    const sustained = scoreCodingContext(Array(6).fill(weakCode));
    expect(sustained.intensity).toBeGreaterThan(
      scoreCodingContext([weakCode]).intensity,
    );
  });

  test("intensity is a bounded proportion in [0, 1)", () => {
    const hot = scoreCodingContext(Array(6).fill(code));
    expect(hot.intensity).toBeGreaterThan(0);
    expect(hot.intensity).toBeLessThan(1);
  });

  test("perTurn ages the current message at 0, newest last", () => {
    const ctx = scoreCodingContext([chat, code]);
    expect(ctx.perTurn.at(-1)?.age).toBe(0);
    expect(ctx.perTurn.at(0)?.age).toBe(1);
  });
});

describe("resolveSwapModel — context path (with history)", () => {
  const PRIMARY = "gpt-5.2";
  const CODING = "glm-5.3";

  test("history present → weak follow-up keeps the coding brain", () => {
    const d = resolveSwapModel({
      text: "what about the error handling in the second commit",
      primaryModel: PRIMARY,
      codingModel: CODING,
      history: [
        { role: "user", text: "refactor the auth code in src" },
        { role: "assistant", text: "done, here's the diff ..." },
      ],
    });
    expect(d.swapped).toBe(true);
    expect(d.model).toBe(CODING);
    expect(d.reason).toMatch(/intensity|hard-carry|anchor-carry/);
  });

  test("assistant turns are ignored (no stuck-mode from code-heavy replies)", () => {
    const d = resolveSwapModel({
      text: "what's for dinner tonight",
      primaryModel: PRIMARY,
      codingModel: CODING,
      // only an assistant code-heavy reply in history; user side is pure chat
      history: [{ role: "assistant", text: "refactor the code in src/foo.ts" }],
    });
    expect(d.swapped).toBe(false);
    expect(d.model).toBe(PRIMARY);
  });

  test("override still wins over the context score", () => {
    const d = resolveSwapModel({
      text: "hi there",
      override: "on",
      primaryModel: PRIMARY,
      codingModel: CODING,
      history: [{ role: "user", text: "hello" }],
    });
    expect(d.swapped).toBe(true);
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
