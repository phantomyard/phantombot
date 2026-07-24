import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mergePiApiKey,
  piAuthJsonPath,
  writePiApiKey,
} from "../src/lib/piAuthStore.ts";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "phantombot-piauth-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("piAuthJsonPath", () => {
  test("points at ~/.pi/agent/auth.json under the given home", () => {
    expect(piAuthJsonPath("/h")).toBe(join("/h", ".pi", "agent", "auth.json"));
  });
});

describe("mergePiApiKey", () => {
  test("fresh install (no file) starts from an empty store", () => {
    const r = mergePiApiKey(undefined, "openrouter", "sk-or-1");
    expect(r.action).toBe("write");
    if (r.action === "write") {
      expect(r.store).toEqual({
        openrouter: { type: "api_key", key: "sk-or-1" },
      });
    }
  });

  test("preserves other providers' entries verbatim", () => {
    const existing = JSON.stringify({
      google: { type: "api_key", key: "gk" },
      "google-gemini-cli": {
        type: "oauth",
        access: "a",
        refresh: "r",
        expires: 123,
      },
    });
    const r = mergePiApiKey(existing, "openrouter", "sk-or-1");
    expect(r.action).toBe("write");
    if (r.action === "write") {
      expect(r.store.google).toEqual({ type: "api_key", key: "gk" });
      expect(r.store["google-gemini-cli"]).toEqual({
        type: "oauth",
        access: "a",
        refresh: "r",
        expires: 123,
      });
      expect(r.store.openrouter).toEqual({ type: "api_key", key: "sk-or-1" });
    }
  });

  test("replaces an existing api_key entry for the same provider", () => {
    const existing = JSON.stringify({
      openrouter: { type: "api_key", key: "old" },
    });
    const r = mergePiApiKey(existing, "openrouter", "new");
    expect(r.action).toBe("write");
    if (r.action === "write") {
      expect(r.store.openrouter).toEqual({ type: "api_key", key: "new" });
    }
  });

  test("skips when the provider already has an oauth entry", () => {
    const existing = JSON.stringify({
      "google-gemini-cli": { type: "oauth", access: "a", refresh: "r" },
    });
    const r = mergePiApiKey(existing, "google-gemini-cli", "gk");
    expect(r.action).toBe("skip-oauth");
  });

  test("refuses to clobber unparseable JSON", () => {
    const r = mergePiApiKey("{not json", "openrouter", "sk-or-1");
    expect(r.action).toBe("refuse");
  });

  test("refuses when the top level is not an object", () => {
    for (const text of ['"str"', "[1,2]", "42", "null"]) {
      expect(mergePiApiKey(text, "openrouter", "k").action).toBe("refuse");
    }
  });
});

describe("writePiApiKey", () => {
  test("creates ~/.pi/agent/auth.json (and parents) at mode 600", async () => {
    const r = await writePiApiKey("openrouter", "sk-or-1", home);
    expect(r.ok).toBe(true);
    const path = piAuthJsonPath(home);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      openrouter: { type: "api_key", key: "sk-or-1" },
    });
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe("600");
  });

  test("merges into an existing store without touching other entries", async () => {
    const path = piAuthJsonPath(home);
    await writePiApiKey("google", "gk", home);
    await writePiApiKey("openrouter", "sk-or-1", home);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      google: { type: "api_key", key: "gk" },
      openrouter: { type: "api_key", key: "sk-or-1" },
    });
  });

  test("oauth entry for the same provider is left untouched", async () => {
    const path = piAuthJsonPath(home);
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    const oauth = {
      "google-gemini-cli": { type: "oauth", access: "a", refresh: "r" },
    };
    await writeFile(path, JSON.stringify(oauth), { mode: 0o600 });
    const before = await readFile(path, "utf8");
    const r = await writePiApiKey("google-gemini-cli", "gk", home);
    expect(r).toMatchObject({ ok: true, skipped: "oauth-present" });
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("concurrent writers for different providers both land (no lost update)", async () => {
    // Regression for PR #314 review: a shared fixed tempfile plus unserialized
    // read→merge→rename let overlapping writers drop each other's entry.
    const providers = Array.from({ length: 8 }, (_, i) => `provider-${i}`);
    const results = await Promise.all(
      providers.map((p) => writePiApiKey(p, `key-${p}`, home)),
    );
    for (const r of results) expect(r.ok).toBe(true);
    const path = piAuthJsonPath(home);
    const store = JSON.parse(await readFile(path, "utf8"));
    for (const p of providers) {
      expect(store[p]).toEqual({ type: "api_key", key: `key-${p}` });
    }
  });

  test("concurrent writers leave no stray tempfiles behind", async () => {
    await Promise.all([
      writePiApiKey("a", "ka", home),
      writePiApiKey("b", "kb", home),
    ]);
    const dir = join(home, ".pi", "agent");
    const leftovers = (await readdir(dir)).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  test("unparseable existing file: reports failure and does not clobber", async () => {
    const path = piAuthJsonPath(home);
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await writeFile(path, "{not json", { mode: 0o600 });
    const r = await writePiApiKey("openrouter", "sk-or-1", home);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("refusing to clobber");
    expect(await readFile(path, "utf8")).toBe("{not json");
  });
});
