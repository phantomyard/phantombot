/**
 * Dropping an image into the chat box (#729): the pure half.
 *
 * A drop arrives as the path the terminal typed. These pin how that text is
 * read (escapes, quotes, `~/`, Windows drives), when it counts as a drop at
 * all, and what the harness is finally sent.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_DROPPED_IMAGE_BYTES,
  imageToken,
  nextImageNumber,
  splitDroppedPaths,
  stashDroppedImages,
  withAttachedImages,
} from "../src/tui/imageDrop.ts";

describe("splitDroppedPaths", () => {
  test("Terminal.app's backslash-escaped path, with its trailing space", () => {
    expect(
      splitDroppedPaths("/Users/me/Desktop/Screenshot\\ 2026-10-30\\ at\\ 15.01.02.png "),
    ).toEqual(["/Users/me/Desktop/Screenshot 2026-10-30 at 15.01.02.png"]);
  });

  test("a 12-hour screenshot name keeps its U+202F (macOS does not escape it)", () => {
    expect(
      splitDroppedPaths("/Users/me/Screenshot\\ 2026-10-30\\ at\\ 3.01.02\u202fPM.png "),
    ).toEqual(["/Users/me/Screenshot 2026-10-30 at 3.01.02\u202fPM.png"]);
  });

  test("several files dropped at once", () => {
    expect(splitDroppedPaths("/a/one.png /b/two\\ 2.jpg ")).toEqual([
      "/a/one.png",
      "/b/two 2.jpg",
    ]);
  });

  test("quoted paths, single and double", () => {
    expect(splitDroppedPaths("'/a/my shot.png' \"/b/it's.gif\"")).toEqual([
      "/a/my shot.png",
      "/b/it's.gif",
    ]);
  });

  test("Windows drive paths keep their backslashes", () => {
    expect(splitDroppedPaths("C:\\Users\\me\\shot.png")).toEqual([
      "C:\\Users\\me\\shot.png",
    ]);
    expect(splitDroppedPaths('"C:\\Users\\me\\my shot.png"')).toEqual([
      "C:\\Users\\me\\my shot.png",
    ]);
  });

  test("~/ is the home directory", () => {
    expect(splitDroppedPaths("~/Desktop/a.png")).toEqual([
      join(homedir(), "Desktop/a.png"),
    ]);
  });

  test("anything that is not only absolute paths is not a drop", () => {
    for (const chunk of [
      "",
      "   ",
      "hello world",
      "see /a/one.png",
      "/a/one.png and more",
      "relative/one.png",
      "'/a/unterminated.png",
      "'/a/one.png'x",
    ]) {
      expect(splitDroppedPaths(chunk)).toBeUndefined();
    }
  });
});

describe("stashDroppedImages", () => {
  let dir: string;
  let inbox: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tui-image-drop-"));
    inbox = join(dir, "inbox", "cli_tui_lab");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("copies each image into the inbox by content hash, in drop order", async () => {
    await mkdir(join(dir, "Desk top"));
    const a = join(dir, "Desk top", "Shot A.PNG");
    const b = join(dir, "b.jpeg");
    await writeFile(a, "png-bytes");
    await writeFile(b, "jpeg-bytes");
    // As the terminal types it: Terminal.app escapes the space, Windows
    // Terminal quotes the path.
    const typed = process.platform === "win32" ? `"${a}"` : a.replaceAll(" ", "\\ ");
    const chunk = `${typed} ${b} `;
    const stashed = stashDroppedImages(chunk, inbox)!;
    expect(stashed).toHaveLength(2);
    expect(stashed[0]!.startsWith(inbox)).toBe(true);
    expect(stashed[0]!).toMatch(/[0-9a-f]{16}\.png$/);
    expect(stashed[1]!).toMatch(/[0-9a-f]{16}\.jpeg$/);
    expect(readFileSync(stashed[0]!, "utf8")).toBe("png-bytes");
    expect(readFileSync(stashed[1]!, "utf8")).toBe("jpeg-bytes");
  });

  test("the copy outlives the original (a screenshot thumbnail's temp file)", async () => {
    const shot = join(dir, "Screenshot.png");
    await writeFile(shot, "pixels");
    const [copy] = stashDroppedImages(shot, inbox)!;
    await rm(shot);
    expect(readFileSync(copy!, "utf8")).toBe("pixels");
  });

  test("dropping the same image twice writes one file", async () => {
    const shot = join(dir, "a.png");
    await writeFile(shot, "same");
    const first = stashDroppedImages(shot, inbox)!;
    const second = stashDroppedImages(shot, inbox)!;
    expect(second).toEqual(first);
    expect(readdirSync(inbox)).toHaveLength(1);
  });

  test("not all images, or not all there: plain text, nothing written", async () => {
    const png = join(dir, "a.png");
    const txt = join(dir, "notes.txt");
    const empty = join(dir, "empty.png");
    const folder = join(dir, "folder.png");
    const big = join(dir, "big.png");
    await writeFile(png, "x");
    await writeFile(txt, "x");
    await writeFile(empty, "");
    await mkdir(folder);
    await writeFile(big, "");
    await truncate(big, MAX_DROPPED_IMAGE_BYTES + 1);
    for (const chunk of [
      txt,
      `${png} ${txt}`,
      `${png} ${join(dir, "missing.png")}`,
      empty,
      folder,
      big,
      "hello",
    ]) {
      expect(stashDroppedImages(chunk, inbox)).toBeUndefined();
    }
    expect(existsSync(inbox)).toBe(false);
  });

  test("an image exactly at the cap is accepted", async () => {
    const atCap = join(dir, "cap.webp");
    await writeFile(atCap, "");
    await truncate(atCap, MAX_DROPPED_IMAGE_BYTES);
    expect(stashDroppedImages(atCap, inbox)).toHaveLength(1);
  });
});

describe("tokens and the message the harness gets", () => {
  test("numbers continue above the highest held", () => {
    expect(nextImageNumber(new Map())).toBe(1);
    expect(nextImageNumber(new Map([[1, "/a"], [3, "/c"]]))).toBe(4);
  });

  test("one [attached:] line per token still in the text, in number order", () => {
    const images = new Map([
      [2, "/inbox/b.png"],
      [1, "/inbox/a.png"],
    ]);
    expect(
      withAttachedImages(`compare ${imageToken(2)} with ${imageToken(1)}`, images),
    ).toBe(
      "compare [Image #2] with [Image #1]\n\n[attached: /inbox/a.png]\n[attached: /inbox/b.png]",
    );
  });

  test("a deleted token attaches nothing; no images leaves the text alone", () => {
    const images = new Map([
      [1, "/inbox/a.png"],
      [10, "/inbox/j.png"],
    ]);
    // `[Image #10]` must not count as `[Image #1]`.
    expect(withAttachedImages("look at [Image #10]", images)).toBe(
      "look at [Image #10]\n\n[attached: /inbox/j.png]",
    );
    expect(withAttachedImages("never mind", images)).toBe("never mind");
    expect(withAttachedImages("plain", new Map())).toBe("plain");
  });
});
