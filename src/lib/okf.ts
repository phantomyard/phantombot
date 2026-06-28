/**
 * Minimal Open Knowledge Format (OKF) aware parser for memory/ and kb/ notes.
 *
 * OKF (Google Cloud's open spec, github.com/GoogleCloudPlatform/knowledge-catalog)
 * describes a knowledge "concept" as a markdown file with YAML frontmatter
 * (`type`, `title`, `description`, `tags`, …) and a body, where concepts link
 * to each other with plain markdown links to form a graph.
 *
 * Phantombot's kb/ second brain is already this shape (Obsidian-style atomic
 * notes with frontmatter + links). This parser extracts the structured parts
 * so the FTS5 index can:
 *   - weight frontmatter fields above body text (BM25F),
 *   - index tags + aliases as controlled vocabulary (synonym fix), and
 *   - follow links between concepts for graph-walk recall expansion.
 *
 * It is deliberately dependency-free and forgiving: a note with no frontmatter,
 * malformed YAML, or no links still parses into a sane OkfDoc (everything in
 * `body`, empty field lists). This is a search-index helper, not a validator —
 * it must never throw on real-world content.
 */

export interface OkfDoc {
  /** `title:` from frontmatter, else the first markdown H1, else "". */
  title: string;
  /** `type:` from frontmatter (OKF's only required field), else "". */
  type: string;
  /** `description:`/`summary:` from frontmatter, else "". */
  description: string;
  /** `tags:` — normalised lowercase, deduped. */
  tags: string[];
  /** `aliases:`/`alias:` — alternate names this concept goes by. */
  aliases: string[];
  /** All ATX/setext heading texts in the body (for mid-weight matching). */
  headings: string[];
  /** Body text with frontmatter stripped. */
  body: string;
  /** Outbound links to other concepts (markdown + wikilink targets). */
  links: OkfLink[];
}

export interface OkfLink {
  /** Raw link target as written, e.g. "infra/dns.md" or "DNS Runbook". */
  target: string;
  /** "md" for [text](path), "wiki" for [[Wikilink]]. */
  kind: "md" | "wiki";
}

const FRONTMATTER_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

/**
 * Parse a note's raw content into an OkfDoc. Never throws.
 */
export function parseOkf(raw: string): OkfDoc {
  const { frontmatter, body } = splitFrontmatter(raw);
  const fm = parseFrontmatter(frontmatter);

  const headings = extractHeadings(body);
  const title =
    str(fm.title) ||
    str(fm.name) ||
    headings[0] ||
    "";

  return {
    title,
    type: str(fm.type),
    description: str(fm.description) || str(fm.summary),
    tags: list(fm.tags ?? fm.tag).map(normTag).filter(Boolean),
    aliases: dedupe(list(fm.aliases ?? fm.alias).map((s) => s.trim()).filter(Boolean)),
    headings,
    body,
    links: extractLinks(body),
  };
}

/** Split leading YAML frontmatter (if any) from the markdown body. */
export function splitFrontmatter(raw: string): {
  frontmatter: string;
  body: string;
} {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return { frontmatter: "", body: stripBom(raw) };
  return { frontmatter: m[1] ?? "", body: raw.slice(m[0].length) };
}

/**
 * Tiny YAML-subset parser: flat `key: value` pairs plus block/flow lists.
 * Handles the shapes OKF/Obsidian frontmatter actually uses:
 *
 *   title: My Concept
 *   tags: [infra, dns, networking]
 *   aliases:
 *     - name resolution
 *     - DNS
 *
 * Nested maps and multi-line scalars are ignored (kept out of the index
 * rather than mis-parsed). Returns a plain record; values are string or
 * string[]. Never throws.
 */
export function parseFrontmatter(src: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (!src.trim()) return out;

  const lines = src.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    i++;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;

    const m = line.match(/^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/);
    if (!m) continue;
    const key = (m[1] ?? "").toLowerCase();
    const rest = (m[2] ?? "").trim();

    if (rest === "") {
      // Possible block list on following indented "- item" lines.
      const items: string[] = [];
      while (i < lines.length) {
        const next = lines[i] ?? "";
        const lm = next.match(/^[ \t]+-[ \t]+(.*)$/);
        if (!lm) break;
        items.push(unquote((lm[1] ?? "").trim()));
        i++;
      }
      out[key] = items;
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      // Flow list: [a, b, c]
      out[key] = rest
        .slice(1, -1)
        .split(",")
        .map((s) => unquote(s.trim()))
        .filter((s) => s.length > 0);
    } else {
      out[key] = unquote(rest);
    }
  }
  return out;
}

/** ATX (`# h`) and setext (underlined) heading texts, in document order. */
function extractHeadings(body: string): string[] {
  const out: string[] = [];
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const atx = line.match(/^#{1,6}[ \t]+(.+?)[ \t]*#*\s*$/);
    if (atx) {
      out.push((atx[1] ?? "").trim());
      continue;
    }
    const next = lines[i + 1] ?? "";
    if (line.trim() && /^(=+|-+)\s*$/.test(next) && !line.startsWith("-")) {
      out.push(line.trim());
    }
  }
  return out;
}

/**
 * Outbound links: markdown `[text](target)` and `[[wikilink]]`. External
 * URLs (http/https/mailto) and in-page anchors (#…) are skipped — only
 * concept-to-concept links matter for graph expansion.
 */
export function extractLinks(body: string): OkfLink[] {
  const out: OkfLink[] = [];
  const seen = new Set<string>();

  // [[Wikilink]] or [[path|alias]] — take the part before '|'.
  for (const m of body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
    const target = (m[1] ?? "").trim();
    if (!target) continue;
    const key = `wiki:${target.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ target, kind: "wiki" });
  }

  // [text](target)
  for (const m of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = (m[1] ?? "").trim();
    // Strip optional "title" and #anchor.
    target = target.replace(/\s+["'].*$/, "").split("#")[0]!.trim();
    if (!target) continue;
    if (/^(https?:|mailto:|tel:|ftp:|#)/i.test(target)) continue;
    const key = `md:${target.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ target, kind: "md" });
  }
  return out;
}

// --- small helpers -------------------------------------------------------

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function str(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v.join(" ");
  return (v ?? "").trim();
}

function list(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  if (Array.isArray(v)) return v;
  // Comma- or space-separated inline value, e.g. "infra, dns".
  return v
    .split(/[,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function normTag(t: string): string {
  return t.trim().replace(/^#/, "").toLowerCase();
}

function dedupe(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const k = x.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function unquote(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    return s.slice(1, -1);
  }
  return s;
}
