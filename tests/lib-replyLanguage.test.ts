import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIDENCE_FLOOR,
  detectLanguage,
  recallReplyLanguage,
  rememberReplyLanguage,
  replyLanguageStatePath,
  resolveReplyLanguage,
} from "../src/lib/replyLanguage.ts";

const SAVED = process.env.PHANTOMBOT_REPLY_LANGUAGE_STATE;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "phantombot-reply-language-"));
  process.env.PHANTOMBOT_REPLY_LANGUAGE_STATE = join(dir, "state.json");
});

afterEach(async () => {
  if (SAVED === undefined) delete process.env.PHANTOMBOT_REPLY_LANGUAGE_STATE;
  else process.env.PHANTOMBOT_REPLY_LANGUAGE_STATE = SAVED;
  await rm(dir, { recursive: true, force: true });
});

describe("detectLanguage", () => {
  const confident: Array<[string, string]> = [
    ["Robbie, what is the COP of my heat pump this winter?", "en"],
    ["Please give me the figures but not in a table, it does not render properly.", "en"],
    ["Robbie, por favor revisa el correo y dime si han contestado sobre la pension.", "es"],
    ["Buenos dias, necesito que prepares el PR y lo dejes listo para revision.", "es"],
    ["Kun je even kijken of de warmtepomp vannacht gedraaid heeft? Het was koud.", "nl"],
    ["Kannst du bitte nachsehen, ob die Rechnung schon bezahlt wurde? Danke sehr.", "de"],
    ["Peux-tu verifier si la facture a ete payee, s'il te plait ? Merci beaucoup.", "fr"],
  ];

  for (const [text, code] of confident) {
    test(`classifies ${code}: ${text.slice(0, 32)}...`, () => {
      const detected = detectLanguage(text);
      expect(detected.code).toBe(code);
      expect(detected.confidence).toBeGreaterThanOrEqual(CONFIDENCE_FLOOR);
    });
  }

  // The floor, not the verdict, is what protects the conversation here:
  // "ok" is the same word in four of the supported languages.
  for (const text of ["ok", "yes please", "\u{1F44D}", "si", ""]) {
    test(`refuses to classify a short message: ${JSON.stringify(text)}`, () => {
      expect(detectLanguage(text).confidence).toBeLessThan(CONFIDENCE_FLOOR);
    });
  }

  test("accented spelling classifies the same as the folded spelling", () => {
    const accented = detectLanguage(
      "Robbie, ¿puedes revisar el correo y decirme si también contestaron?",
    );
    expect(accented.code).toBe("es");
    expect(accented.confidence).toBeGreaterThanOrEqual(CONFIDENCE_FLOOR);
  });

  test("English survives a message full of non-English proper nouns", () => {
    // Content words carry no language: this is the shape of a real message
    // here, and a naive character-frequency classifier gets it wrong.
    const detected = detectLanguage(
      "Can you check whether the Remeha Elga Ace and the Kospel EKD.M3 are both on the Tibber tariff?",
    );
    expect(detected.code).toBe("en");
    expect(detected.confidence).toBeGreaterThanOrEqual(CONFIDENCE_FLOOR);
  });

  test("code blocks and URLs do not dilute the verdict", () => {
    const detected = detectLanguage(
      "Please check this for me:\n```\nconst x = await fetch(url);\n```\nhttps://example.com/some/very/long/path",
    );
    expect(detected.code).toBe("en");
  });
});

describe("reply language carry-forward store", () => {
  const who = { persona: "phantom", conversation: "telegram:1001" };

  test("remembers and recalls a language", async () => {
    await rememberReplyLanguage({
      ...who,
      language: { code: "es", name: "Spanish" },
    });
    expect(await recallReplyLanguage(who)).toEqual({
      code: "es",
      name: "Spanish",
    });
  });

  test("a stale entry is not recalled", async () => {
    const then = new Date("2026-09-01T00:00:00Z");
    await rememberReplyLanguage({
      ...who,
      language: { code: "es", name: "Spanish" },
      now: then,
    });
    expect(
      await recallReplyLanguage({
        ...who,
        now: new Date(then.getTime() + 1000),
        ttlMs: 500,
      }),
    ).toBeUndefined();
  });

  test("languages are per conversation, not per persona", async () => {
    await rememberReplyLanguage({
      ...who,
      language: { code: "es", name: "Spanish" },
    });
    expect(
      await recallReplyLanguage({ ...who, conversation: "telegram:2002" }),
    ).toBeUndefined();
  });

  test("a corrupt state file degrades to no memory instead of throwing", async () => {
    await writeFile(replyLanguageStatePath(), "{not json", "utf8");
    expect(await recallReplyLanguage(who)).toBeUndefined();
  });
});

describe("resolveReplyLanguage", () => {
  const who = { persona: "phantom", conversation: "telegram:1001" };

  test("a confident detection is returned and remembered", async () => {
    const resolved = await resolveReplyLanguage({
      ...who,
      text: "Robbie, can you check whether the invoice was paid yesterday?",
    });
    expect(resolved).toEqual({ code: "en", name: "English" });
    expect(await recallReplyLanguage(who)).toEqual({
      code: "en",
      name: "English",
    });
  });

  test("a bare 'ok' carries the conversation's language forward", async () => {
    await resolveReplyLanguage({
      ...who,
      text: "Robbie, por favor revisa el correo y dime si han contestado.",
    });
    expect(await resolveReplyLanguage({ ...who, text: "ok" })).toEqual({
      code: "es",
      name: "Spanish",
    });
  });

  test("a confident switch overrides what was carried forward", async () => {
    await resolveReplyLanguage({
      ...who,
      text: "Robbie, por favor revisa el correo y dime si han contestado.",
    });
    expect(
      await resolveReplyLanguage({
        ...who,
        text: "Actually, can you give me that in English with the figures?",
      }),
    ).toEqual({ code: "en", name: "English" });
  });

  test("no detection and no memory yields no instruction at all", async () => {
    expect(await resolveReplyLanguage({ ...who, text: "ok" })).toBeUndefined();
  });
});
