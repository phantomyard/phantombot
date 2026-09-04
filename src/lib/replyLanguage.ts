import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { xdgStateHome } from "../config.ts";
import { writeFileAtomic } from "./io.ts";

/**
 * Deterministic, local reply-language detection for the channel layer.
 *
 * Why this exists: reply FORMAT (voice vs text) is resolved in code and
 * stated to the harness; reply LANGUAGE was prompt-level only, so it
 * drifted. A persona asked something in English would answer in Spanish
 * because something ELSE in the turn was Spanish - retrieved memory, the
 * daily journal, or its own previous turn spent composing a Spanish
 * email. Both are the same failure: inferring the reply language from
 * task content instead of from the message being replied to.
 *
 * Two design constraints follow from that:
 *
 *   1. Detection runs on the INBOUND USER MESSAGE ONLY. Never on
 *      retrieved context, journal, quoted replies or prior assistant
 *      turns - those are precisely the pollution sources.
 *   2. It is a local heuristic, not a model call. This runs on every
 *      inbound message; a network round-trip on the hot path would buy
 *      accuracy nobody asked for at a latency cost everybody pays.
 *
 * The classifier is a weighted function-word scorer. Function words are
 * the highest-signal, lowest-cost language cue in short chat messages:
 * frequent, closed-class, and largely disjoint across the languages this
 * deployment actually sees. Content words are ignored - "PR", "merge",
 * "Tibber" and "Azorra" carry no language.
 */

export interface DetectedLanguage {
  /** ISO 639-1 code, e.g. "en"; "und" when unclassifiable. */
  code: string;
  /** English name of the language, e.g. "English" - what we tell the harness. */
  name: string;
  /**
   * 0-1. At or above CONFIDENCE_FLOOR the detection is trusted, remembered
   * and injected; below it the caller carries the conversation's last
   * confident language forward instead.
   */
  confidence: number;
}

/**
 * Function words, per language. `strong` entries rarely appear in the
 * other supported languages, so they carry more weight; `common` entries
 * are shared enough (Romance "la"/"un"/"che") that a single hit means
 * little on its own.
 */
const LEXICON: Record<
  string,
  { name: string; strong: string[]; common: string[] }
> = {
  en: {
    name: "English",
    strong: [
      "the", "and", "you", "please", "that", "this", "with", "what",
      "when", "have", "will", "your", "they", "would", "could", "should",
      "about", "there", "been", "just", "know", "like", "need", "want",
      "thanks", "thank", "which", "because", "does", "did", "doesn't",
      "don't", "i'm", "it's", "we're", "isn't", "can't", "rather",
      "instead", "still", "these", "those", "them", "then", "than",
      "whether", "should", "something", "anything", "everything",
    ],
    common: [
      "is", "it", "of", "to", "in", "on", "do", "how", "why", "who",
      "we", "my", "are", "can", "not", "but", "for", "from", "was",
      "get", "make", "now", "also", "yes", "a", "an", "me", "at", "as",
      "by", "or", "if", "so", "up", "out", "all", "one", "give", "let",
      "see", "here", "back", "same", "any", "some", "each", "very",
      "much", "more", "again", "over", "into", "only", "both",
    ],
  },
  es: {
    name: "Spanish",
    strong: [
      "que", "por", "para", "pero", "como", "cuando", "donde", "esto",
      "eso", "esta", "hay", "tiene", "tengo", "puedes", "puedo", "favor",
      "gracias", "tambien", "porque", "ahora", "hola", "quiero",
      "necesito", "del", "muy", "hacer", "los", "las", "una", "con",
      "estan", "mas", "si",
    ],
    common: ["de", "la", "el", "un", "no", "y", "o", "en", "al", "se", "me", "te", "lo"],
  },
  nl: {
    name: "Dutch",
    strong: [
      "het", "een", "van", "dat", "niet", "ik", "jij", "wij", "maar",
      "ook", "voor", "zijn", "heb", "hebben", "kan", "kun", "kunt",
      "wat", "waar", "wanneer", "hoe", "graag", "alsjeblieft", "bedankt",
      "dank", "even", "nog", "wel", "moet", "doen", "mijn", "jouw",
      "naar", "goed", "weer", "zou", "want", "omdat", "altijd",
      "misschien", "volgens", "welke", "deze", "dit", "onze", "hun",
    ],
    common: ["de", "en", "is", "je", "met", "op", "aan", "om", "te", "er"],
  },
  de: {
    name: "German",
    strong: [
      "der", "die", "das", "und", "nicht", "ich", "wir", "sind", "eine",
      "mit", "aber", "auch", "noch", "schon", "kann", "koennen", "was",
      "wann", "wie", "bitte", "danke", "muss", "machen", "haben", "mein",
      "wo", "oder", "sehr", "wird",
    ],
    common: ["ist", "ein", "von", "zu", "du", "es", "im", "am", "so", "auf"],
  },
  fr: {
    name: "French",
    strong: [
      "les", "des", "une", "est", "pas", "je", "nous", "vous", "avec",
      "pour", "sur", "dans", "mais", "aussi", "qui", "quand", "comment",
      "peux", "peut", "merci", "faire", "etre", "mon", "cette", "sont",
      "tout", "bien", "quoi", "plait", "beaucoup", "ete", "tres",
      "alors", "donc", "encore", "deja", "elle", "toi", "leur", "sans",
      "chez", "toujours", "jamais",
    ],
    common: ["le", "la", "et", "un", "en", "du", "au", "ce", "il", "que", "ne", "a", "tu", "ma", "sa", "ses", "vos", "moi", "on"],
  },
  it: {
    name: "Italian",
    strong: [
      "gli", "sono", "anche", "quando", "come", "puoi", "posso",
      "grazie", "fare", "essere", "mio", "questo", "questa", "molto",
      "adesso", "ciao", "sulla", "nella", "degli", "delle", "sempre",
      "perche", "cosa", "dove", "ancora", "quindi", "allora",
    ],
    common: ["il", "lo", "la", "le", "un", "una", "e", "io", "tu", "noi", "con", "per", "su", "in", "ma", "chi", "che", "non"],
  },
  pt: {
    name: "Portuguese",
    strong: [
      "voce", "nos", "obrigado", "obrigada", "fazer", "meu", "isso",
      "muito", "agora", "ola", "porque", "entao", "sobre", "seu",
      "esta", "estao", "tambem",
    ],
    common: ["o", "a", "os", "as", "um", "uma", "e", "eu", "em", "que", "do", "da", "nao", "para", "com", "mas"],
  },
};

/** Orthographic cues no function word covers. Cheap, and decisive when present. */
const CHAR_HINTS: Array<{ code: string; re: RegExp; weight: number }> = [
  { code: "es", re: /[ñ¿¡]/, weight: 4 },
  { code: "pt", re: /[ãõ]/, weight: 4 },
  { code: "de", re: /ß/, weight: 4 },
  { code: "de", re: /[äöü]/, weight: 1 },
  { code: "fr", re: /[çœèê]/, weight: 1 },
  { code: "it", re: /[àìòù]/, weight: 1 },
];

const STRONG_WEIGHT = 3;
const COMMON_WEIGHT = 1;

/**
 * Minimum word count for a verdict. Below this a message is not
 * reliably classifiable - "ok", "yes please" and an emoji are the same
 * in half of Europe - and a one-word reply must never flip a
 * conversation's language.
 */
export const MIN_TOKENS_FOR_DETECTION = 4;

/** Detections at or above this are trusted, remembered, and injected. */
export const CONFIDENCE_FLOOR = 0.6;

/**
 * Fold the accented forms of the supported languages onto ASCII before
 * matching, so a lexicon written in ASCII still matches "también" and
 * "está". The accents themselves are scored separately by CHAR_HINTS,
 * against the RAW text, so folding here costs no signal.
 */
function fold(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Strip everything that is not natural language before tokenizing.
 * Code, URLs, file paths and IDs are language-neutral noise that
 * dilutes the hit rate and pushes real messages under the floor.
 */
function tokenize(text: string): string[] {
  const cleaned = fold(text)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\S+@\S+\.\S+/g, " ")
    .replace(/\S*\/\S+/g, " ")
    .toLowerCase();
  return cleaned
    .replace(/\u2019/g, "'")
    .split(/[^\p{L}']+/u)
    .filter((t) => t.length > 0);
}

/**
 * Classify the language of one inbound message.
 *
 * Never throws: an unclassifiable message comes back with confidence 0
 * rather than a guess, which the caller turns into "carry the
 * conversation's language forward".
 */
export function detectLanguage(text: string): DetectedLanguage {
  const unknown: DetectedLanguage = {
    code: "und",
    name: "unknown",
    confidence: 0,
  };
  if (!text) return unknown;
  const tokens = tokenize(text);
  if (tokens.length < MIN_TOKENS_FOR_DETECTION) return unknown;

  const scores = new Map<string, number>();
  for (const [code, lex] of Object.entries(LEXICON)) {
    const strong = new Set(lex.strong);
    const common = new Set(lex.common);
    let score = 0;
    for (const token of tokens) {
      if (strong.has(token)) score += STRONG_WEIGHT;
      else if (common.has(token)) score += COMMON_WEIGHT;
    }
    scores.set(code, score);
  }
  for (const hint of CHAR_HINTS) {
    if (hint.re.test(text)) {
      scores.set(hint.code, (scores.get(hint.code) ?? 0) + hint.weight);
    }
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [bestCode, bestScore] = ranked[0]!;
  const secondScore = ranked[1]?.[1] ?? 0;
  if (bestScore <= 0) return unknown;

  // Two independent conditions, because they fail independently:
  //   coverage - did enough of the message look like this language at
  //              all (guards against one lucky hit in a wall of nouns)
  //   margin   - was it a clear winner (guards against the Spanish /
  //              Portuguese / Italian coin-flips, where carrying the
  //              conversation's language forward beats guessing)
  const coverage = Math.min(
    1,
    bestScore / (tokens.length * STRONG_WEIGHT * 0.5),
  );
  const margin = (bestScore - secondScore) / bestScore;
  const name = LEXICON[bestCode]!.name;
  if (coverage < 0.3 || margin < 0.2) {
    return { code: bestCode, name, confidence: Math.min(0.4, coverage) };
  }
  return {
    code: bestCode,
    name,
    confidence: Math.min(1, 0.15 + coverage * 0.45 + margin * 0.45),
  };
}

// ---------------------------------------------------------------------------
// Per-conversation carry-forward store
// ---------------------------------------------------------------------------

interface StoredLanguage {
  code: string;
  name: string;
  touchedAt: string;
}

type StoredLanguages = Record<string, StoredLanguage>;

/**
 * Idle TTL for the remembered language. Longer than the reply-mode
 * override (10 min) on purpose: a conversation's language is a property
 * of who is talking, not a momentary format request. After a day of
 * silence we would rather re-detect than assume.
 */
export const DEFAULT_REPLY_LANGUAGE_TTL_MS = 86_400_000;

export function replyLanguageStatePath(): string {
  return (
    process.env.PHANTOMBOT_REPLY_LANGUAGE_STATE ??
    join(xdgStateHome(), "phantombot", "reply-language.json")
  );
}

function key(persona: string, conversation: string): string {
  return `${persona} ${conversation}`;
}

async function load(path: string): Promise<StoredLanguages> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as StoredLanguages)
      : {};
  } catch {
    // A missing, torn or hand-edited file must never drop an inbound
    // message: this overlay is an enhancement, so degrade to "no memory"
    // rather than throwing on the message path.
    return {};
  }
}

async function save(state: StoredLanguages, path: string): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(state, null, 2) + "\n");
}

export async function rememberReplyLanguage(input: {
  persona: string;
  conversation: string;
  language: { code: string; name: string };
  now?: Date;
}): Promise<void> {
  const path = replyLanguageStatePath();
  const state = await load(path);
  state[key(input.persona, input.conversation)] = {
    code: input.language.code,
    name: input.language.name,
    touchedAt: (input.now ?? new Date()).toISOString(),
  };
  await save(state, path);
}

export async function recallReplyLanguage(input: {
  persona: string;
  conversation: string;
  ttlMs?: number;
  now?: Date;
}): Promise<{ code: string; name: string } | undefined> {
  const ttlMs = input.ttlMs ?? DEFAULT_REPLY_LANGUAGE_TTL_MS;
  const now = input.now ?? new Date();
  const state = await load(replyLanguageStatePath());
  const entry = state[key(input.persona, input.conversation)];
  if (!entry) return undefined;
  const touched = Date.parse(entry.touchedAt);
  if (!Number.isFinite(touched) || now.getTime() - touched > ttlMs) {
    return undefined;
  }
  return { code: entry.code, name: entry.name };
}

/**
 * The channel-layer entry point: detect, and fall back to the
 * conversation's last confident language when this message is too short
 * to classify. Returns undefined when we have neither - in which case no
 * language instruction is injected at all and the persona's own
 * mirroring norm applies, which is the honest behaviour rather than a
 * coin-flip stated to the harness as fact.
 */
export async function resolveReplyLanguage(input: {
  persona: string;
  conversation: string;
  text: string;
  ttlMs?: number;
  now?: Date;
}): Promise<{ code: string; name: string } | undefined> {
  const detected = detectLanguage(input.text);
  if (detected.confidence >= CONFIDENCE_FLOOR) {
    const language = { code: detected.code, name: detected.name };
    await rememberReplyLanguage({
      persona: input.persona,
      conversation: input.conversation,
      language,
      now: input.now,
    });
    return language;
  }
  return await recallReplyLanguage({
    persona: input.persona,
    conversation: input.conversation,
    ttlMs: input.ttlMs,
    now: input.now,
  });
}
