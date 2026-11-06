/**
 * Static guard for the site's in-page links.
 *
 * PR #779 put PhantomTools in the header nav as `<a href="#phantomtools">` but
 * rendered the section as `<section class="phantomtools">` with no id, so the
 * nav item jumped nowhere. Nothing else caught it: the page returns 200, the
 * markup parses, and the anchor only rots at click time in a browser. This test
 * asserts the invariant instead — every `href="#fragment"` on the page resolves
 * to an element carrying that id.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const html = readFileSync(join(import.meta.dir, "..", "www", "index.html"), "utf8");

function collapse(htmlText: string): string {
  return htmlText.replace(/\s+/g, " ");
}

describe("www/index.html in-page links", () => {
  test("every href=\"#fragment\" resolves to an element with that id", () => {
    const page = collapse(html);
    const fragments = new Set<string>();
    for (const match of page.matchAll(/href="#([^"]*)"/g)) if (match[1] !== undefined) fragments.add(match[1]);
    const ids = new Set<string>();
    for (const match of page.matchAll(/\bid="([^"]*)"/g)) if (match[1] !== undefined) ids.add(match[1]);

    const dead = [...fragments].filter((f) => f !== "" && !ids.has(f));
    expect(dead).toEqual([]);
  });

  test("the header nav's PhantomTools link lands on the PhantomTools section", () => {
    const page = collapse(html);
    expect(page).toMatch(/<a href="#phantomtools">PhantomTools<\/a>/);
    expect(page).toMatch(/<section class="phantomtools" id="phantomtools">/);
  });
});
