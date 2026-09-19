/**
 * Deterministic language gate for pre-tool narration (issue #580).
 *
 * WHY THIS EXISTS
 * ---------------
 * The reply-language rule ("write your reply, including every pre-tool
 * narration line, in the language of the user's latest message") is prose, and
 * prose has now failed at it twice: #548 introduced the rule, #581 removed the
 * duplicate copy of it that was making things worse. Across ~14,800 scored
 * turns on two personas, every observed violation was a *narration* line in the
 * wrong language while the reply body was correct.
 *
 * So this module takes model compliance out of the delivery path for the one
 * thing that actually leaks. It is deliberately NOT a general-purpose language
 * identifier and must not be used as one:
 *
 *   - It answers one question — "is this short line confidently in a DIFFERENT
 *     language from that one?" — not "what language is this?".
 *   - It is precision-first. Every ambiguous case returns `undefined`, which
 *     the caller treats as "leave it alone". A missed leak costs nothing; a
 *     false positive silently eats a narration line the user wanted.
 *   - It never gates the reply BODY. A body legitimately quotes foreign text
 *     ("How do you say that in French?" → a French sentence), and the body has
 *     never been observed to leak.
 *
 * Two stages, cheapest first:
 *
 *   1. SCRIPT. Non-Latin scripts (Cyrillic, Han, Kana, Hangul, Arabic, Hebrew,
 *      Greek, Devanagari, Thai) are decided by codepoint alone — no word list,
 *      no training data, and correct for every language written in them. This
 *      is the branch #534's classifier got wrong by going silent on scripts it
 *      could not score.
 *   2. LATIN FUNCTION WORDS. Within the Latin script we score a small set of
 *      Western European languages using words that are EXCLUSIVE to one of the
 *      profiles below. Shared words ("de", "la", "in") are ignored entirely
 *      rather than guessed at, which is what keeps precision high on the
 *      ~6-word strings narration actually consists of.
 *
 * Adding a language means adding a profile. A language with no profile is
 * simply never detected, and therefore never gated — degrading to today's
 * behaviour rather than to a wrong answer.
 */

/** Minimum alphabetic tokens before we are willing to guess at all. */
const MIN_TOKENS = 3;
/** Minimum exclusive-marker hits for a Latin-script verdict. */
const MIN_EXCLUSIVE_HITS = 2;
/**
 * The winner must hold this share of all exclusive hits. Below it the line is
 * genuinely mixed ("¡Por fin! This one's clean.") and we leave it alone.
 */
const MIN_WINNER_SHARE = 0.75;
/** Share of letters one non-Latin script must hold to decide by script alone. */
const MIN_SCRIPT_SHARE = 0.6;

/**
 * Non-Latin scripts, keyed by the code we report. Detecting at SCRIPT level is
 * intentional: to know that Cyrillic narration does not belong on an English
 * prompt we do not need to tell Russian from Ukrainian, and pretending we can
 * would only add a way to be wrong.
 */
const SCRIPTS: ReadonlyArray<readonly [string, RegExp]> = [
  ["cyrl", /[Ѐ-ӿԀ-ԯ]/u],
  ["grek", /[Ͱ-Ͽἀ-῿]/u],
  ["hani", /[一-鿿㐀-䶿]/u],
  ["kana", /[぀-ヿ]/u],
  ["hang", /[가-힯ᄀ-ᇿ]/u],
  ["arab", /[؀-ۿݐ-ݿ]/u],
  ["hebr", /[֐-׿]/u],
  ["deva", /[ऀ-ॿ]/u],
  ["thai", /[฀-๿]/u],
];

const LATIN = /[A-Za-zÀ-ɏ]/u;

/**
 * Function words per language.
 *
 * Only words that end up EXCLUSIVE to one profile are ever scored, and
 * exclusivity is computed against THESE LISTS — not against the real world. So
 * the load-bearing discipline when editing is the opposite of what you'd
 * expect: a word shared with another profiled language must be listed in EVERY
 * profile that owns it, so the profiles cancel each other out. Omitting "in"
 * from Dutch would not make Dutch weaker, it would make "in" a false English
 * marker and mis-gate Dutch narration. `tests/language-gate.test.ts` pins the
 * known-shared words against exactly this mistake.
 */
const PROFILES: Readonly<Record<string, readonly string[]>> = {
  en: [
    // exclusive
    "the", "and", "you", "your", "yours", "for", "with", "this", "that", "these",
    "those", "from", "into", "have", "has", "had", "will", "would", "should",
    "could", "are", "was", "were", "been", "being", "let", "just", "then",
    "about", "what", "which", "where", "when", "who", "why", "how", "there",
    "their", "they", "them", "we", "our", "us", "its", "of", "to", "or", "not",
    "but", "if", "so", "any", "all", "each", "every", "both", "same", "such",
    "more", "most", "other", "over", "after", "before", "still", "already",
    "again", "yet", "much", "many", "than", "while", "because", "though",
    "between", "does", "did", "doing", "make", "made", "get", "got", "need",
    "want", "know", "think", "like", "check", "checking", "looking", "reading",
    "pulling", "running", "grabbing", "fetching", "opening", "asking", "sec",
    "second", "first", "next", "here", "now", "one", "two", "am", "it", "on",
    "at", "as", "by", "be", "up", "out", "can", "my",
    // shared — listed so they cancel. "war" and "die" are here because they
    // are ordinary English words that are also German function words; without
    // them an English line mentioning a war would vote German.
    "a", "in", "is", "no", "me", "do", "i", "an", "war", "die", "man",
  ],
  es: [
    // exclusive
    "el", "los", "las", "unos", "unas", "del", "al", "esto", "eso", "esta",
    "estos", "estas", "que", "qué", "porque", "pero", "para", "con", "sin",
    "sobre", "está", "están", "estoy", "estamos", "es", "son", "ser", "hay",
    "muy", "ya", "ahora", "luego", "aquí", "ahí", "allí", "también", "tambien",
    "voy", "vamos", "miro", "mirando", "busco", "buscando", "reviso",
    "revisando", "saco", "sacando", "verifico", "comprobando", "déjame",
    "dejame", "dame", "momento", "según", "segun", "tengo", "tiene", "hacer",
    "hago", "puedo", "puede", "puedes", "quiero", "necesito", "parece", "vale",
    "listo", "hecho", "hoy", "mañana", "ayer", "sí", "nos", "les", "su", "sus", "son",
    "mis", "tus", "cuando", "cuándo", "donde", "dónde", "cómo", "cuál", "nada",
    "todo", "todos", "algo", "bien", "más", "menos", "entre", "desde", "hasta",
    "hacia", "durante", "antes", "después", "despues", "mientras", "aunque",
    "cada", "otro", "otra", "mismo", "código", "codigo", "archivo", "mensaje",
    "cuenta", "año", "años", "otra", "usted",
    // shared — listed so they cancel
    "a", "de", "se", "no", "me", "te", "lo", "una", "la", "le", "e", "i", "mi",
    "tu", "como", "si", "por", "un", "en", "y", "o", "das", "dos", "esse",
  ],
  fr: [
    // exclusive
    "les", "des", "du", "aux", "ce", "cette", "ces", "cela", "qui", "pour",
    "avec", "sans", "sur", "dans", "mais", "donc", "est", "sont", "être",
    "etre", "avoir", "fait", "faire", "je", "vous", "nous", "cherche",
    "regarde", "vérifie", "verifie", "ouvre", "lis", "voici", "voilà", "voila",
    "maintenant", "ensuite", "aussi", "très", "tres", "déjà", "deja", "son",
    "instant", "fichier", "année", "annee", "quoi", "où", "comment", "pourquoi",
    "toujours", "encore", "chaque", "autre", "même", "tout", "tous", "rien",
    "bien", "plus", "moins", "entre", "depuis", "vers", "pendant", "avant",
    "après", "apres", "alors", "aussi", "quand", "parce",
    // shared — listed so they cancel
    "a", "de", "se", "ne", "me", "te", "la", "le", "une", "en", "et", "au",
    "il", "on", "y", "ou", "si", "par", "un", "i", "e", "que",
  ],
  de: [
    // exclusive
    "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem",
    "und", "oder", "aber", "nicht", "kein", "keine", "ist", "sind", "war",
    "waren", "sein", "haben", "hat", "wird", "werden", "ich", "wir", "sie",
    "schaue", "prüfe", "pruefe", "lese", "hole", "jetzt", "dann", "auch",
    "sehr", "schon", "noch", "hier", "dort", "datei", "nachricht", "für",
    "fuer", "mit", "ohne", "über", "ueber", "nach", "vor", "bei", "zum", "zur",
    "was", "wer", "wie", "wo", "warum", "immer", "jede", "jeder", "andere",
    "alles", "nichts", "mehr", "weniger", "zwischen", "seit", "während",
    "waehrend", "weil", "wenn",
    // shared — listed so they cancel
    "in", "im", "an", "am", "zu", "so", "es", "da", "man", "de", "e", "i",
  ],
  nl: [
    // exclusive
    "het", "een", "van", "voor", "met", "zonder", "maar", "want", "dus",
    "niet", "geen", "dat", "deze", "dit", "die", "zijn", "waren", "heeft",
    "hebben", "wordt", "worden", "ik", "jij", "wij", "kijk", "even", "kijken",
    "haal", "lees", "controleer", "dan", "ook", "hier", "daar", "bestand",
    "bericht", "jaar", "alleen", "wat", "wie", "hoe", "waar", "waarom",
    "altijd", "nog", "elke", "andere", "alles", "niets", "meer", "minder",
    "tussen", "sinds", "tijdens", "omdat", "als", "naar", "over", "aan",
    "bij", "uit", "op", "zo", "nu", "toch", "wel",
    // shared — listed so they cancel
    "in", "is", "we", "was", "je", "de", "te", "en", "of", "me", "er", "e",
    "i", "u", "a", "men", "door", "man",
  ],
  it: [
    // exclusive
    "gli", "della", "dello", "delle", "degli", "nel", "nella", "perché",
    "perche", "però", "pero", "sono", "sia", "essere", "avere", "faccio",
    "fare", "guardo", "controllo", "adesso", "poi", "anche", "molto", "già",
    "gia", "qui", "messaggio", "anno", "sto", "cosa", "chi", "come", "dove",
    "quando", "sempre", "ancora", "ogni", "altro", "tutto", "tutti", "niente",
    "bene", "meno", "fra", "durante", "prima", "dopo", "mentre", "quindi",
    "con", "senza", "sul", "nei", "alla", "allo", "agli", "dal", "dai",
    // shared — listed so they cancel
    "a", "di", "de", "se", "no", "me", "te", "lo", "la", "le", "i", "e", "in",
    "il", "un", "una", "non", "che", "per", "da", "o", "si", "sua", "mi",
  ],
  pt: [
    // exclusive
    "não", "nao", "dos", "das", "pelo", "pela", "isso", "isto", "aquele",
    "então", "entao", "estou", "estão", "estao", "ter", "tenho", "faço",
    "faco", "faz", "olho", "vejo", "agora", "depois", "também", "tambem",
    "muito", "já", "ja", "arquivo", "mensagem", "ano", "você", "voce", "onde",
    "quando", "quem", "sempre", "ainda", "cada", "outro", "tudo", "todos",
    "nada", "bem", "mais", "menos", "entre", "desde", "até", "ate", "durante",
    "antes", "enquanto", "porque", "com", "sem", "sobre", "para", "eu",
    // shared — listed so they cancel
    "a", "de", "se", "no", "me", "te", "o", "os", "as", "um", "uma", "e",
    "i", "do", "na", "em", "que", "por", "mas", "esse", "essa", "ser", "la",
  ],
};

/** word -> the single profile that owns it, or null if more than one does. */
const EXCLUSIVE: ReadonlyMap<string, string> = (() => {
  const owners = new Map<string, string | null>();
  for (const [code, words] of Object.entries(PROFILES)) {
    for (const word of words) {
      owners.set(word, owners.has(word) ? null : code);
    }
  }
  const out = new Map<string, string>();
  for (const [word, owner] of owners) if (owner) out.set(word, owner);
  return out;
})();

/**
 * The profile that exclusively owns `word`, or `undefined` when more than one
 * profile lists it (and it therefore never votes). Exported for the test that
 * pins the known-shared words — see the note on `PROFILES` for why that
 * overlap is the load-bearing part of this module.
 */
export function languageMarkerOwner(word: string): string | undefined {
  return EXCLUSIVE.get(word.toLowerCase());
}

export interface LanguageGuess {
  /** ISO-639-1 code for a profiled Latin language, or a 4-letter script tag. */
  code: string;
  /** Share of exclusive hits held by the winner (1 for a script verdict). */
  confidence: number;
}

/**
 * Strip everything that carries no language: code, URLs, paths, identifiers,
 * digits, emoji. Narration is short, so a single stray `~/src/lib/foo.ts` is
 * enough to swamp six real words if we leave it in.
 */
function stripNonProse(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, " ")
    .replace(/[~./]?(?:[\w-]+\/)+[\w.-]*/g, " ")
    // Any dotted identifier: hostnames (`nos.lol`), filenames (`relays.json`),
    // module paths (`channels.core.streaming`). Observed to matter — a bare
    // list of relay domains scored as Portuguese before this line existed.
    .replace(/\b[\p{L}\d_-]+(?:\.[\p{L}\d_-]+)+\b/gu, " ")
    .replace(/[#@][\w-]+/g, " ")
    .replace(/\d+/g, " ");
}

function tokenize(text: string): string[] {
  return (
    stripNonProse(text)
      .toLowerCase()
      .match(/[\p{L}]+(?:['’][\p{L}]+)?/gu) ?? []
  ).map((w) => w.replace(/’/g, "'"));
}

/**
 * Best-effort language of `text`, or `undefined` when we are not confident —
 * which is the common case for short interstitials ("ok", "Checking…") and is
 * exactly the intended behaviour. Never throws.
 */
export function detectLanguage(text: string): LanguageGuess | undefined {
  const prose = stripNonProse(text);

  let latin = 0;
  const scriptCounts = new Map<string, number>();
  for (const ch of prose) {
    if (LATIN.test(ch)) {
      latin++;
      continue;
    }
    for (const [code, re] of SCRIPTS) {
      if (re.test(ch)) {
        scriptCounts.set(code, (scriptCounts.get(code) ?? 0) + 1);
        break;
      }
    }
  }
  let totalLetters = latin;
  for (const n of scriptCounts.values()) totalLetters += n;
  if (totalLetters === 0) return undefined;

  for (const [code, count] of scriptCounts) {
    if (count / totalLetters >= MIN_SCRIPT_SHARE) return { code, confidence: 1 };
  }
  // A non-Latin script present but not dominant means a mixed line — a Latin
  // sentence quoting a Chinese name. Refuse rather than score the remainder.
  if (scriptCounts.size > 0) return undefined;

  const tokens = tokenize(text);
  if (tokens.length < MIN_TOKENS) return undefined;

  const hits = new Map<string, number>();
  let total = 0;
  for (const token of tokens) {
    const owner = EXCLUSIVE.get(token);
    if (!owner) continue;
    hits.set(owner, (hits.get(owner) ?? 0) + 1);
    total++;
  }
  if (total < MIN_EXCLUSIVE_HITS) return undefined;

  let best = "";
  let bestCount = 0;
  for (const [code, count] of hits) {
    if (count > bestCount) {
      best = code;
      bestCount = count;
    }
  }
  const confidence = bestCount / total;
  if (confidence < MIN_WINNER_SHARE) return undefined;
  return { code: best, confidence };
}

/**
 * Should a narration line in `candidate` be withheld from a user who wrote in
 * `expected`?
 *
 * TRUE only when BOTH sides are confidently identified and they differ. Every
 * other combination — either side unreadable, either side too short, same
 * language — returns false, i.e. send it. The asymmetry is deliberate: the
 * gate exists to remove a known wrong output, not to police an uncertain one.
 */
export function shouldWithholdNarration(
  expectedSource: string,
  candidate: string,
): boolean {
  const expected = detectLanguage(expectedSource);
  if (!expected) return false;
  const actual = detectLanguage(candidate);
  if (!actual) return false;
  return expected.code !== actual.code;
}
