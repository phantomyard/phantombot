/**
 * Tests for `phantombot fix-signing`. The real signing work is injected via the
 * applySigning seam, so we only assert the command's wiring:
 *
 *   - non-macOS is a friendly no-op (exit 0, nothing applied)
 *   - running from source (bun, not a real binary) is refused (exit 1)
 *   - success prints the grant-once guidance (exit 0)
 *   - failure prints the "nothing broken / retry" fallback (exit 1)
 */

import { describe, expect, test } from "bun:test";

import { runFixSigning } from "../src/cli/fix-signing.ts";

function sink() {
  let text = "";
  return {
    write: (s: string) => {
      text += s;
      return true;
    },
    get text() {
      return text;
    },
  };
}

describe("runFixSigning", () => {
  test("non-macOS → no-op exit 0, never calls applySigning", async () => {
    const out = sink();
    let applied = false;
    const code = await runFixSigning({
      procPlatform: "linux",
      binPath: "/usr/bin/phantombot",
      out,
      err: sink(),
      applySigning: async () => {
        applied = true;
        return { ok: true, message: "x" };
      },
    });
    expect(code).toBe(0);
    expect(applied).toBe(false);
    expect(out.text).toContain("macOS-only");
  });

  test("refuses when not run from a real phantombot binary", async () => {
    const err = sink();
    const code = await runFixSigning({
      procPlatform: "darwin",
      binPath: "/opt/homebrew/bin/bun",
      out: sink(),
      err,
    });
    expect(code).toBe(1);
    expect(err.text).toContain("installed phantombot binary");
  });

  test("success → exit 0 with grant-once guidance", async () => {
    const out = sink();
    const code = await runFixSigning({
      procPlatform: "darwin",
      binPath: "/Users/x/.local/bin/phantombot",
      out,
      err: sink(),
      applySigning: async () => ({ ok: true, message: "identity installed" }),
    });
    expect(code).toBe(0);
    expect(out.text).toContain("identity installed");
  });

  test("failure → exit 1 with fail-safe fallback message", async () => {
    const err = sink();
    const code = await runFixSigning({
      procPlatform: "darwin",
      binPath: "/Users/x/.local/bin/phantombot",
      out: sink(),
      err,
      applySigning: async () => ({ ok: false, message: "codesign failed" }),
    });
    expect(code).toBe(1);
    expect(err.text).toContain("Nothing was broken");
    expect(err.text).toContain("Full Disk Access");
  });
});
