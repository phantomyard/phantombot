export interface StreamSegmenterOptions {
  maxSentences: number;
  maxChars: number;
  hardMaxChars?: number;
}

export interface SegmentResult {
  segments: string[];
}

const DEFAULT_HARD_MAX_CHARS = 3500;

interface BlockState {
  inFence: boolean;
  fenceMarker: "```" | "~~~" | undefined;
  inTable: boolean;
  inList: boolean;
}

const sentenceSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "sentence" })
    : undefined;

/**
 * Markdown-aware streaming splitter for chat-sized bubbles.
 *
 * It accepts arbitrary text chunks, buffers incomplete lines so markdown
 * block markers are seen whole, and only cuts at safe boundaries. Code fences
 * are held together unless they exceed Telegram's practical source cap; in
 * that forced case the fence is closed and reopened across bubbles.
 */
export class StreamSegmenter {
  private readonly maxSentences: number;
  private readonly maxChars: number;
  private readonly hardMaxChars: number;
  private readonly state: BlockState = {
    inFence: false,
    fenceMarker: undefined,
    inTable: false,
    inList: false,
  };
  private current = "";
  private lineBuffer = "";
  private sentenceCount = 0;
  private forceReopenFence: "```" | "~~~" | undefined;

  constructor(options: StreamSegmenterOptions) {
    this.maxSentences = Math.max(1, options.maxSentences);
    this.maxChars = Math.max(1, options.maxChars);
    this.hardMaxChars = options.hardMaxChars ?? DEFAULT_HARD_MAX_CHARS;
  }

  push(text: string): SegmentResult {
    if (text.length === 0) return { segments: [] };
    const segments: string[] = [];
    this.lineBuffer += text;

    while (true) {
      const nl = this.lineBuffer.indexOf("\n");
      if (nl < 0) break;
      const line = this.lineBuffer.slice(0, nl + 1);
      this.lineBuffer = this.lineBuffer.slice(nl + 1);
      this.consumeLine(line, segments);
    }

    this.flushProseFromLineBuffer(segments);
    return { segments };
  }

  finish(): SegmentResult {
    const segments: string[] = [];
    if (this.lineBuffer.length > 0) {
      const line = this.lineBuffer;
      this.lineBuffer = "";
      this.consumeLine(line, segments);
    }
    this.flushCurrent(segments, { force: true });
    return { segments };
  }

  private consumeLine(line: string, segments: string[]): void {
    const fence = fenceMarker(line);
    if (fence) {
      this.append(line);
      if (this.state.inFence && this.state.fenceMarker === fence) {
        this.state.inFence = false;
        this.state.fenceMarker = undefined;
        this.flushCurrent(segments);
      } else if (!this.state.inFence) {
        this.state.inFence = true;
        this.state.fenceMarker = fence;
      }
      this.enforceHardCap(segments);
      return;
    }

    if (this.state.inFence) {
      this.append(line);
      this.enforceHardCap(segments);
      return;
    }

    const table = isTableLine(line);
    const list = isListLine(line);
    const heading = isHeadingLine(line);

    if (this.state.inTable && !table) {
      this.state.inTable = false;
      this.flushCurrent(segments);
    }
    if (this.state.inList && !list) {
      this.state.inList = false;
      this.flushCurrent(segments);
    }

    this.state.inTable = table;
    this.state.inList = list;

    if (table || list || heading) {
      this.append(line);
      this.flushCurrent(segments);
      return;
    }

    this.consumeProse(line, segments);
  }

  private flushProseFromLineBuffer(segments: string[]): void {
    if (
      this.lineBuffer.length === 0 ||
      this.state.inFence ||
      this.state.inTable ||
      this.state.inList
    ) {
      return;
    }
    const text = this.lineBuffer;
    if (!sentenceLooksComplete(text) && this.current.length + text.length < this.maxChars) {
      return;
    }
    this.lineBuffer = "";
    this.consumeProse(text, segments);
  }

  private append(text: string): void {
    if (this.forceReopenFence) {
      this.current += `${this.forceReopenFence}\n`;
      this.forceReopenFence = undefined;
    }
    this.current += text;
  }

  private consumeProse(text: string, segments: string[]): void {
    for (const sentence of splitSentences(text)) {
      this.append(sentence);
      if (sentenceLooksComplete(sentence)) this.sentenceCount++;
      this.flushCurrent(segments);
    }
  }

  private flushCurrent(
    segments: string[],
    opts: { force?: boolean } = {},
  ): void {
    if (this.current.trim().length === 0) {
      if (opts.force) this.current = "";
      return;
    }
    const safeBoundary =
      !this.state.inFence && !this.state.inTable && !this.state.inList;
    const shouldFlush =
      opts.force ||
      (safeBoundary &&
        (this.sentenceCount >= this.maxSentences ||
          this.current.length >= this.maxChars));
    if (!shouldFlush) return;
    segments.push(this.current);
    this.current = "";
    this.sentenceCount = 0;
  }

  private enforceHardCap(segments: string[]): void {
    if (this.current.length < this.hardMaxChars) return;
    if (this.state.inFence && this.state.fenceMarker) {
      const marker = this.state.fenceMarker;
      segments.push(`${this.current}\n${marker}\n`);
      this.current = "";
      this.forceReopenFence = marker;
      this.sentenceCount = 0;
      return;
    }
    this.flushCurrent(segments, { force: true });
  }
}

/**
 * Does this text carry any actual content — a letter or a digit?
 *
 * A bubble made only of emoji or punctuation ("⚡", "👍", "—") reads as a
 * sign-off when it sits under a real answer, but it is not an answer. On
 * surfaces where the newest message becomes the push notification and the
 * chat-list preview (PhantomChat), a trailing sign-off bubble IS the whole
 * notification — the user sees "max: ⚡" and reasonably concludes they were
 * ignored. Callers use this to keep such fragments attached to the bubble
 * they belong to, rather than shipping them standalone.
 */
export function hasTextSubstance(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * Fold a trailing substance-free fragment back into the bubble before it.
 *
 * The sentence splitter treats "…all merged. ⚡" as two sentences, because the
 * emoji follows terminal punctuation — so a reply that signs off with an emoji
 * ends with a 1-character segment. Merging is only possible when the whole text
 * is segmented in one pass (`splitIntoSegments`); a live `StreamSegmenter` may
 * already have published the previous bubble, so the streaming callers suppress
 * the orphan instead. Kept here so both strategies share one definition of
 * "this fragment is not an answer".
 */
export function coalesceTrailingFragment(segments: string[]): string[] {
  if (segments.length < 2) return segments;
  const last = segments[segments.length - 1]!;
  if (hasTextSubstance(last)) return segments;
  const merged = segments.slice(0, -1);
  merged[merged.length - 1] += last;
  return merged;
}

export function splitIntoSegments(
  text: string,
  options: StreamSegmenterOptions,
): string[] {
  const s = new StreamSegmenter(options);
  const out = s.push(text).segments;
  out.push(...s.finish().segments);
  return coalesceTrailingFragment(out);
}

function fenceMarker(line: string): "```" | "~~~" | undefined {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("```")) return "```";
  if (trimmed.startsWith("~~~")) return "~~~";
  return undefined;
}

function isTableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.includes("|");
}

function isListLine(line: string): boolean {
  return /^\s*(?:[-*+]\s+|\d+\.\s+)/.test(line);
}

function isHeadingLine(line: string): boolean {
  return /^\s{0,3}#{1,6}\s+/.test(line);
}

function splitSentences(text: string): string[] {
  if (!sentenceSegmenter) return fallbackSplitSentences(text);
  const out: string[] = [];
  for (const part of sentenceSegmenter.segment(text)) {
    if (part.segment.length > 0) out.push(part.segment);
  }
  return out;
}

function fallbackSplitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  const re = /[.!?…]["')\]]?\s+/g;
  while (re.exec(text)) {
    out.push(text.slice(start, re.lastIndex));
    start = re.lastIndex;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

function sentenceLooksComplete(text: string): boolean {
  return /[.!?…]["')\]]?\s*$/.test(text.trimEnd());
}
