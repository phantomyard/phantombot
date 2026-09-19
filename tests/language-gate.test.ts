import { describe, expect, test } from "bun:test";
import {
  detectLanguage,
  expectedLanguageOf,
  languageMarkerOwner,
  shouldWithholdNarration,
} from "../src/lib/languageGate";

/**
 * Every "leaked" string below is a REAL pre-tool narration line recovered from
 * a phantom's stored turns, paired with the real English user message that
 * preceded it (issue #580). They are the actual failure the gate exists to
 * stop, so they are the spec — not invented examples.
 */
const REAL_LEAKS: ReadonlyArray<[string, string]> = [
  ["When do we compact or reconstruct history?", "Miro en el código de compactación."],
  [
    "So just to be clear, the current situation is that we use a new key on every message?",
    "Verifico qué se manda hoy.",
  ],
  [
    "Robbie, can you have a read of the energy contract note you made yesterday?",
    "Buscando la nota del contrato de energía.",
  ],
  [
    "Can you please remind me how the harness failover on phantombot works?",
    "Buscando en memoria el failover de harness.",
  ],
  [
    "Robbie, I am driving to Niort in France. I need a decent car park with EV charging.",
    "Cherche les parkings avec bornes de recharge au centre de Niort.",
  ],
];

describe("detectLanguage", () => {
  test("identifies the profiled Latin languages on narration-length input", () => {
    expect(detectLanguage("Checking your calendar for the next slot")?.code).toBe("en");
    expect(detectLanguage("Buscando la nota del contrato de energía")?.code).toBe("es");
    expect(detectLanguage("Je cherche les parkings avec une borne")?.code).toBe("fr");
    expect(detectLanguage("Ik kijk even in het bestand voor jou")?.code).toBe("nl");
    expect(detectLanguage("Ich schaue jetzt in die Datei für dich")?.code).toBe("de");
  });

  test("decides non-Latin scripts by codepoint, with no word list", () => {
    expect(detectLanguage("Проверяю твой календарь")?.code).toBe("cyrl");
    expect(detectLanguage("正在查看你的日历")?.code).toBe("hani");
    expect(detectLanguage("カレンダーを確認しています")?.code).toBe("kana");
    expect(detectLanguage("캘린더를 확인하고 있습니다")?.code).toBe("hang");
    expect(detectLanguage("أتحقق من التقويم الخاص بك")?.code).toBe("arab");
  });

  test("returns undefined rather than guessing at short interstitials", () => {
    for (const s of ["ok", "Checking…", "Un momento", "Sec", "👍", ""]) {
      expect(detectLanguage(s)).toBeUndefined();
    }
  });

  test("returns undefined on mixed-language lines", () => {
    expect(
      detectLanguage("Checking the file — un momento, déjame ver qué hay"),
    ).toBeUndefined();
    // Latin sentence quoting a non-Latin name.
    expect(detectLanguage("Looking up the 日历 entry for you now")).toBeUndefined();
  });

  test("code, paths and identifiers do not vote", () => {
    // Without stripping, the path tokens swamp the four real words.
    expect(
      detectLanguage("Checking src/lib/foo/bar.ts and ~/etc/una/del/las now")?.code,
    ).toBe("en");
    expect(detectLanguage("`el la del los las`")).toBeUndefined();
  });

  test("one marker among proper nouns is below the floor", () => {
    // Two exclusive markers, not one. A narration line that is mostly proper
    // nouns ("Revisando Vesuvius Isio Amity") carries too little evidence to
    // act on, and acting on it would eat a line the user wanted.
    expect(detectLanguage("Revisando Vesuvius Isio Amity")).toBeUndefined();
  });

  test("a split vote is no vote", () => {
    // One English marker and one Spanish marker: real, but genuinely mixed, so
    // the winner never clears MIN_WINNER_SHARE.
    expect(detectLanguage("Checking Isio, Vesuvius y Amity")).toBeUndefined();
  });

  test("dotted identifiers do not vote", () => {
    // Regression: this exact line scored as Portuguese before hostnames were
    // stripped, because `nos.lol` contributed the token "nos".
    expect(
      detectLanguage(
        "**Current (7):** nos.lol, relay.nostr.com, relay.primal.net, offchain.pub",
      ),
    ).toBeUndefined();
  });

  test("words shared between profiled languages never become a marker", () => {
    // The profiles are only as precise as their overlap is complete: a word
    // listed in one profile but missing from another that also owns it becomes
    // a false marker for the first. These are the ones that bite.
    const shared: Record<string, readonly string[]> = {
      in: ["en", "nl", "de", "it"],
      is: ["en", "nl"],
      no: ["en", "es", "it", "pt"],
      de: ["es", "fr", "nl", "pt", "it"],
      se: ["es", "fr", "pt", "it"],
      me: ["en", "es", "fr", "nl", "pt", "it"],
      la: ["es", "fr", "it", "pt", "en"],
      le: ["es", "fr", "it", "en"],
      a: ["en", "es", "fr", "nl", "pt", "it"],
      une: ["fr"],
      war: ["en", "de"],
      die: ["en", "de"],
      son: ["es", "fr"],
      que: ["es", "fr", "pt", "it"],
      si: ["es", "fr", "it"],
      por: ["es", "pt"],
      man: ["de", "nl"],
      was: ["en", "de", "nl"],
      we: ["en", "nl"],
      do: ["en", "pt"],
      of: ["en", "nl"], // "of" is Dutch for "or"
      the: ["en"],
      und: ["de"],
      het: ["nl"],
    };
    for (const [word, owners] of Object.entries(shared)) {
      // A word owned by more than one profiled language must not be exclusive.
      const exclusive = languageMarkerOwner(word);
      if (owners.length > 1) {
        expect([word, exclusive]).toEqual([word, undefined]);
      } else {
        expect([word, exclusive]).toEqual([word, owners[0]]);
      }
    }
  });
});

describe("shouldWithholdNarration", () => {
  test("withholds every real observed leak", () => {
    for (const [userMessage, narration] of REAL_LEAKS) {
      expect(shouldWithholdNarration(userMessage, narration)).toBe(true);
    }
  });

  test("passes narration that matches the user's language", () => {
    expect(
      shouldWithholdNarration(
        "Robbie, vamos a hablar español a partir de ahora por favor",
        "Buscando la nota del contrato de energía.",
      ),
    ).toBe(false);
    expect(
      shouldWithholdNarration(
        "Can you check the energy contract note for me?",
        "Checking that note for you now",
      ),
    ).toBe(false);
  });

  test("passes when either side is unreadable — the gate never guesses", () => {
    // User message too short to score.
    expect(shouldWithholdNarration("ok", "Buscando la nota del contrato")).toBe(false);
    // Narration too short to score.
    expect(shouldWithholdNarration("Can you check the energy note for me?", "Un momento")).toBe(false);
    // User message is a bare file path.
    expect(
      shouldWithholdNarration("~/src/lib/foo.ts", "Buscando la nota del contrato"),
    ).toBe(false);
  });

  test("does not withhold narration about foreign content", () => {
    // The Dutch invoice case: English user, English narration, Dutch subject.
    expect(
      shouldWithholdNarration(
        "Can you read the jaarnota from Vattenfall and tell me the total?",
        "Opening the jaarnota now and pulling the total for you",
      ),
    ).toBe(false);
  });
});

describe("expectedLanguageOf (#583 review)", () => {
  // The two sides fail differently. An unreadable narration line is simply
  // sent; an expected side read WRONG makes the gate act confidently against
  // every correct narration line in the turn. So the expected side reads the
  // user's own words first, not the material they pasted underneath.
  const DUTCH_QUESTION_WITH_ENGLISH_PASTE = [
    "de build is kapot, wat betekent dit?",
    "",
    "Error: the module could not be resolved because the import path does not",
    "exist in this workspace and the build step therefore could not continue",
    "with the rest of the compilation for these files.",
  ].join("\n");

  test("a long quoted paste does not outvote the question it is attached to", () => {
    // Scored whole, the English paste wins and Dutch narration gets eaten.
    expect(detectLanguage(DUTCH_QUESTION_WITH_ENGLISH_PASTE)?.code).toBe("en");
    // Scored as the user's message, the Dutch question decides.
    expect(expectedLanguageOf(DUTCH_QUESTION_WITH_ENGLISH_PASTE)?.code).toBe("nl");
    expect(
      shouldWithholdNarration(
        DUTCH_QUESTION_WITH_ENGLISH_PASTE,
        "Ik kijk even in het bestand voor je",
      ),
    ).toBe(false);
  });

  test("falls back to the whole message when the opening cannot be scored", () => {
    const greeting = [
      "Hi Robbie,",
      "",
      "Can you check the energy contract note and tell me what the total is?",
    ].join("\n");
    expect(expectedLanguageOf(greeting)?.code).toBe("en");
  });

  test("still catches the leak when there is no paste at all", () => {
    expect(
      shouldWithholdNarration(
        "Robbie, can you have a read of the energy contract note you made yesterday?",
        "Buscando la nota del contrato de energía.",
      ),
    ).toBe(true);
  });
});
