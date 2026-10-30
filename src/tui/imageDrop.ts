/**
 * Dropping an image into the chat box (#729).
 *
 * A terminal never hands the app the image itself. Dropping a file onto the
 * window TYPES ITS PATH, as if the user had pasted it: Terminal.app and iTerm2
 * escape spaces with backslashes (`/Users/me/Screenshot\ 1.png `), other
 * terminals quote the path instead. No bracketed paste is enabled, so the
 * path arrives as one plain input chunk.
 *
 * When a chunk is ONLY such paths and every one is an image file, the chat box
 * shows `[Image #1]`, `[Image #2]`, … instead, and the files are copied into
 * the conversation's inbox right away: a macOS screenshot thumbnail points
 * into a temporary folder that is gone a few seconds after the drop. On
 * submit, every token still in the text becomes an `[attached: <abs-path>]`
 * line, the same convention Telegram, PhantomChat and ACP use, so the harness
 * reads the image exactly as it reads a Telegram photo.
 *
 * Anything else is pasted as text, exactly as before: a chunk with a word in
 * it, a path that does not exist, a non-image file, an image over the cap.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";

/** The formats Telegram photos and ACP images arrive in (`extensionFromMime`). */
export const DROPPABLE_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
]);

/** Same cap as a pasted ACP image (`ACP_MAX_IMAGE_BYTES`). */
export const MAX_DROPPED_IMAGE_BYTES = 10 * 1024 * 1024;

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

/**
 * What separates dropped paths: ASCII whitespace only. JavaScript's `\s` also
 * matches U+202F, which macOS puts before "AM"/"PM" in a 12-hour-clock
 * screenshot name ("Screenshot … 3.01.02\u202fPM.png") and does not escape.
 */
const SEPARATOR = /[ \t\r\n]/;

function isAbsolutePath(p: string): boolean {
  // Explicit rather than `path.isAbsolute`, so a drop parses the same way
  // whatever platform runs the tests.
  return p.startsWith("/") || WINDOWS_DRIVE.test(p);
}

/**
 * Split a pasted chunk into the paths a terminal typed for a file drop.
 *
 * Returns `undefined` unless the WHOLE chunk is one or more absolute paths
 * separated by ASCII whitespace (`SEPARATOR`). Backslash escapes are undone in POSIX paths only:
 * in `C:\Users\me` the backslash is the separator, and a Windows terminal
 * quotes a path with spaces instead of escaping them.
 */
export function splitDroppedPaths(chunk: string): string[] | undefined {
  const s = chunk.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  if (!s) return undefined;
  const paths: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && SEPARATOR.test(s[i]!)) i++;
    if (i >= s.length) break;
    let path = "";
    const quote = s[i];
    if (quote === "'" || quote === '"') {
      const end = s.indexOf(quote, i + 1);
      if (end < 0) return undefined;
      path = s.slice(i + 1, end);
      i = end + 1;
      // `'/a.png'x` is not a path followed by a separator.
      if (i < s.length && !SEPARATOR.test(s[i]!)) return undefined;
    } else {
      const windows = WINDOWS_DRIVE.test(s.slice(i, i + 3));
      while (i < s.length && !SEPARATOR.test(s[i]!)) {
        if (s[i] === "\\" && !windows && i + 1 < s.length) {
          path += s[i + 1];
          i += 2;
          continue;
        }
        path += s[i];
        i++;
      }
    }
    if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
    if (!isAbsolutePath(path)) return undefined;
    paths.push(path);
  }
  return paths.length > 0 ? paths : undefined;
}

/** Whether a path names a format the vision path takes, by extension. */
export function isDroppableImage(path: string): boolean {
  return DROPPABLE_IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

/**
 * Copy the images a chunk names into `inbox` and return their new paths, in
 * drop order. `undefined`, with nothing written, unless EVERY path is an
 * existing, non-empty image file within the cap: a drop is all images or it
 * is plain text, never half of each.
 *
 * Files are named by content hash, as ACP names a pasted image, so dropping
 * the same screenshot twice writes one file.
 */
export function stashDroppedImages(
  chunk: string,
  inbox: string,
): string[] | undefined {
  const paths = splitDroppedPaths(chunk);
  if (!paths || !paths.every(isDroppableImage)) return undefined;
  const files: { bytes: Buffer; ext: string }[] = [];
  for (const path of paths) {
    try {
      const st = statSync(path);
      if (!st.isFile() || st.size === 0 || st.size > MAX_DROPPED_IMAGE_BYTES) {
        return undefined;
      }
      files.push({ bytes: readFileSync(path), ext: extname(path).toLowerCase() });
    } catch {
      return undefined;
    }
  }
  try {
    mkdirSync(inbox, { recursive: true });
    return files.map(({ bytes, ext }) => {
      const sha = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
      const dest = join(inbox, `${sha}${ext}`);
      writeFileSync(dest, bytes);
      return dest;
    });
  } catch {
    // An inbox we cannot write to: the user still gets their path as text.
    return undefined;
  }
}

/** The placeholder the chat box shows for image `n`. */
export function imageToken(n: number): string {
  return `[Image #${n}]`;
}

/** The number for the next drop: one above the highest still held. */
export function nextImageNumber(images: ReadonlyMap<number, string>): number {
  let max = 0;
  for (const n of images.keys()) max = Math.max(max, n);
  return max + 1;
}

/**
 * The message the harness gets: the text as typed, `[Image #n]` tokens and
 * all, then one `[attached: <path>]` line per token still in it, in number
 * order. A token the user deleted attaches nothing.
 */
export function withAttachedImages(
  text: string,
  images: ReadonlyMap<number, string>,
): string {
  const lines = [...images]
    .sort(([a], [b]) => a - b)
    .filter(([n]) => text.includes(imageToken(n)))
    .map(([, path]) => `[attached: ${path}]`);
  return lines.length > 0 ? `${text}\n\n${lines.join("\n")}` : text;
}
