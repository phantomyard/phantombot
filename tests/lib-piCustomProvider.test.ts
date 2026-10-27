/**
 * The "bring your own endpoint" providers (issue #694).
 *
 * These carry the risk the rest of the provider catalogue does not: Pi knows
 * nothing about them until phantombot writes a `models.json` entry, so a wrong
 * merge or a stale endpoint shows up as "Use /login to log into a provider" on
 * a live turn. The merge rules and the drift check are therefore pure and
 * pinned here.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildProviderEntry,
  clearCustomProviderEntry,
  customProviderAllowsKeyless,
  customProviderModels,
  customProviderSpec,
  ensureCustomProviderEntry,
  entryMatches,
  isCustomProvider,
  mergeProviderEntry,
  modelsJsonPath,
  NO_KEY_PLACEHOLDER,
  normalizeBaseUrl,
  OPENAI_COMPATIBLE_KEY_ENV,
  OPENAI_COMPATIBLE_PROVIDER,
  PHANTOOPS_DEFAULT_BASE_URL,
  PHANTOOPS_KEY_ENV,
  PHANTOOPS_PROVIDER,
  plaintextKeyWarning,
  readCustomProviderEntry,
  removeProviderEntry,
  resolveCustomProviderBaseUrl,
  restoreModelsJson,
  snapshotModelsJson,
  storedBaseUrlForProvider,
  writeCustomProviderEntry,
} from "../src/lib/piCustomProvider.ts";

async function scratchAgentDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pb-custom-provider-"));
}

describe("provider specs", () => {
  test("both providers are recognised and carry their own key env var", () => {
    expect(customProviderSpec(OPENAI_COMPATIBLE_PROVIDER)?.keyEnv).toBe(
      OPENAI_COMPATIBLE_KEY_ENV,
    );
    expect(customProviderSpec(PHANTOOPS_PROVIDER)?.keyEnv).toBe(PHANTOOPS_KEY_ENV);
    expect(isCustomProvider(PHANTOOPS_PROVIDER)).toBe(true);
    // A catalog provider must never be treated as bring-your-own-endpoint:
    // Pi knows its endpoint, so writing a models.json entry would shadow it.
    expect(isCustomProvider("openrouter")).toBe(false);
    expect(isCustomProvider(undefined)).toBe(false);
  });

  test("only PhantomOps has a default endpoint and a default model", () => {
    expect(customProviderSpec(PHANTOOPS_PROVIDER)?.needsBaseUrl).toBe(false);
    expect(customProviderSpec(PHANTOOPS_PROVIDER)?.defaultBaseUrl).toBe(
      PHANTOOPS_DEFAULT_BASE_URL,
    );
    expect(customProviderSpec(PHANTOOPS_PROVIDER)?.defaultModel).toBe("phantomops/auto");
    // A self-hosted endpoint cannot be guessed — the operator must state it.
    expect(customProviderSpec(OPENAI_COMPATIBLE_PROVIDER)?.needsBaseUrl).toBe(true);
    expect(customProviderSpec(OPENAI_COMPATIBLE_PROVIDER)?.defaultBaseUrl).toBeUndefined();
  });
});

describe("normalizeBaseUrl", () => {
  test("keeps a clean endpoint as typed", () => {
    expect(normalizeBaseUrl("http://localhost:11434/v1")).toEqual({
      ok: true,
      value: "http://localhost:11434/v1",
    });
  });

  test("strips the trailing slash operators paste from their server's output", () => {
    expect(normalizeBaseUrl("http://localhost:11434/v1/")).toEqual({
      ok: true,
      value: "http://localhost:11434/v1",
    });
    expect(normalizeBaseUrl("https://box.lan/v1///")).toEqual({
      ok: true,
      value: "https://box.lan/v1",
    });
  });

  test("strips a pasted completion or models path so Pi cannot double it up", () => {
    // Pi appends /chat/completions and /models itself; a pasted full path would
    // otherwise become /v1/chat/completions/chat/completions.
    expect(normalizeBaseUrl("https://box.lan/v1/chat/completions")).toEqual({
      ok: true,
      value: "https://box.lan/v1",
    });
    expect(normalizeBaseUrl("https://box.lan/v1/models/")).toEqual({
      ok: true,
      value: "https://box.lan/v1",
    });
    expect(normalizeBaseUrl("https://box.lan/v1/completions")).toEqual({
      ok: true,
      value: "https://box.lan/v1",
    });
  });

  test("requires an explicit scheme", () => {
    const bare = normalizeBaseUrl("localhost:11434/v1");
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.error).toContain("http://");
    expect(normalizeBaseUrl("box.lan/v1").ok).toBe(false);
  });

  test("rejects blank and scheme-only input", () => {
    expect(normalizeBaseUrl(undefined).ok).toBe(false);
    expect(normalizeBaseUrl("   ").ok).toBe(false);
    expect(normalizeBaseUrl("https://").ok).toBe(false);
  });
});

describe("plaintextKeyWarning (review, Lena — prompt-copy only)", () => {
  test("https never warns", () => {
    expect(plaintextKeyWarning("https://box.lan/v1")).toBeUndefined();
  });

  test("plain http on loopback is fine — LM Studio / Ollama speak it", () => {
    expect(plaintextKeyWarning("http://localhost:11434/v1")).toBeUndefined();
    expect(plaintextKeyWarning("http://127.0.0.1:8080/v1")).toBeUndefined();
    expect(plaintextKeyWarning("http://[::1]:8080/v1")).toBeUndefined();
  });

  test("plain http BEYOND loopback warns the key travels unencrypted", () => {
    const warn = plaintextKeyWarning("http://10.0.0.5:8000/v1");
    expect(warn).toContain("unencrypted");
    expect(plaintextKeyWarning("http://inference.example/v1")).toContain(
      "unencrypted",
    );
  });

  test("an unparseable URL warns nothing — normalizeBaseUrl owns that error", () => {
    expect(plaintextKeyWarning("not a url")).toBeUndefined();
  });
});

describe("resolveCustomProviderBaseUrl", () => {
  test("an operator value wins over the provider default", () => {
    expect(resolveCustomProviderBaseUrl(PHANTOOPS_PROVIDER, "https://dev.box/api/v1/")).toBe(
      "https://dev.box/api/v1",
    );
  });

  test("PhantomOps falls back to the gateway when nothing is stored", () => {
    expect(resolveCustomProviderBaseUrl(PHANTOOPS_PROVIDER, undefined)).toBe(
      PHANTOOPS_DEFAULT_BASE_URL,
    );
    expect(resolveCustomProviderBaseUrl(PHANTOOPS_PROVIDER, "  ")).toBe(
      PHANTOOPS_DEFAULT_BASE_URL,
    );
  });

  test("openai-compatible has no default — an unset endpoint is NOT a guess", () => {
    expect(resolveCustomProviderBaseUrl(OPENAI_COMPATIBLE_PROVIDER, undefined)).toBeUndefined();
  });

  test("an unusable stored value is reported as unconfigured, never guessed", () => {
    expect(resolveCustomProviderBaseUrl(OPENAI_COMPATIBLE_PROVIDER, "localhost:8000")).toBeUndefined();
  });

  test("catalog providers have no base URL notion at all", () => {
    expect(resolveCustomProviderBaseUrl("openrouter", "https://x")).toBeUndefined();
  });
});

describe("customProviderModels", () => {
  test("the provider default comes first, then the caller's models", () => {
    expect(customProviderModels(PHANTOOPS_PROVIDER, ["openrouter/foo"]).map((m) => m.id)).toEqual([
      "phantomops/auto",
      "openrouter/foo",
    ]);
  });

  test("de-duplicates and drops blanks, preserving order", () => {
    expect(
      customProviderModels(PHANTOOPS_PROVIDER, [
        "phantomops/auto",
        "  ",
        "openrouter/foo",
        "openrouter/foo",
      ]).map((m) => m.id),
    ).toEqual(["phantomops/auto", "openrouter/foo"]);
  });

  test("openai-compatible has no default model, so the caller's list stands", () => {
    expect(customProviderModels(OPENAI_COMPATIBLE_PROVIDER, ["llama3.1:70b"]).map((m) => m.id)).toEqual([
      "llama3.1:70b",
    ]);
  });
});

describe("buildProviderEntry", () => {
  test("references the key's env var — the value is never written to disk", () => {
    const entry = buildProviderEntry({
      id: PHANTOOPS_PROVIDER,
      baseUrl: PHANTOOPS_DEFAULT_BASE_URL,
      models: ["phantomops/auto"],
    });
    expect(entry).toEqual({
      baseUrl: PHANTOOPS_DEFAULT_BASE_URL,
      api: "openai-completions",
      apiKey: "$PHANTOOPS_API_KEY",
      models: [{ id: "phantomops/auto" }],
    });
    // A `$` reference, not a literal: pin it explicitly — a regression here
    // would put a credential in a world-readable agent dir.
    expect(entry.apiKey.startsWith("$")).toBe(true);
  });

  test("an unauthenticated endpoint gets a literal placeholder, not an unresolvable reference", () => {
    // Verified against pi 1.0.4: a provider whose apiKey cannot be resolved is
    // INVISIBLE to pi, so "no key" must be spelled as a dummy literal.
    const entry = buildProviderEntry({
      id: OPENAI_COMPATIBLE_PROVIDER,
      baseUrl: "http://localhost:11434/v1",
      models: ["llama3"],
      keyAvailable: false,
    });
    expect(entry.apiKey).toBe(NO_KEY_PLACEHOLDER);
    expect(entry.apiKey.startsWith("$")).toBe(false);
  });

  test("refuses a catalog provider id", () => {
    expect(() =>
      buildProviderEntry({ id: "openrouter", baseUrl: "https://x" }),
    ).toThrow();
  });
});

describe("mergeProviderEntry", () => {
  const entry = buildProviderEntry({
    id: PHANTOOPS_PROVIDER,
    baseUrl: PHANTOOPS_DEFAULT_BASE_URL,
  });

  test("creates the document shape when the file is absent or empty", () => {
    for (const existing of [undefined, "", "   "]) {
      const merged = mergeProviderEntry(existing, PHANTOOPS_PROVIDER, entry);
      expect(merged.ok).toBe(true);
      if (merged.ok) {
        expect(JSON.parse(merged.text)).toEqual({
          providers: { [PHANTOOPS_PROVIDER]: entry },
        });
      }
    }
  });

  test("keeps every foreign key and foreign provider verbatim", () => {
    // The agent dir is shared with whatever the operator (or a host pi) put
    // there — clobbering it would delete their setup.
    const existing = JSON.stringify({
      version: 3,
      providers: { ollama: { baseUrl: "http://localhost:11434/v1", models: [] } },
    });
    const merged = mergeProviderEntry(existing, PHANTOOPS_PROVIDER, entry);
    expect(merged.ok).toBe(true);
    if (merged.ok) {
      const doc = JSON.parse(merged.text);
      expect(doc.version).toBe(3);
      expect(doc.providers.ollama).toEqual({
        baseUrl: "http://localhost:11434/v1",
        models: [],
      });
      expect(doc.providers[PHANTOOPS_PROVIDER]).toEqual(entry);
    }
  });

  test("replaces OUR entry on rewrite (a moved endpoint must not survive)", () => {
    const first = mergeProviderEntry(undefined, PHANTOOPS_PROVIDER, entry);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const moved = buildProviderEntry({
      id: PHANTOOPS_PROVIDER,
      baseUrl: "https://dev.box/api/v1",
    });
    const second = mergeProviderEntry(first.text, PHANTOOPS_PROVIDER, moved);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(JSON.parse(second.text).providers[PHANTOOPS_PROVIDER].baseUrl).toBe(
        "https://dev.box/api/v1",
      );
    }
  });

  test("refuses to clobber an unparseable document", () => {
    const merged = mergeProviderEntry("{ not json", PHANTOOPS_PROVIDER, entry);
    expect(merged.ok).toBe(false);
    if (!merged.ok) expect(merged.error).toContain("not valid JSON");
  });

  test("refuses non-object documents and a non-object providers key", () => {
    expect(mergeProviderEntry("[1,2]", PHANTOOPS_PROVIDER, entry).ok).toBe(false);
    expect(mergeProviderEntry("null", PHANTOOPS_PROVIDER, entry).ok).toBe(false);
    expect(mergeProviderEntry('"text"', PHANTOOPS_PROVIDER, entry).ok).toBe(false);
    const bad = mergeProviderEntry('{"providers": []}', PHANTOOPS_PROVIDER, entry);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("providers");
  });
});

describe("removeProviderEntry", () => {
  test("removes only ours and keeps the rest", () => {
    const existing = JSON.stringify({
      providers: { ollama: { baseUrl: "http://x" }, [PHANTOOPS_PROVIDER]: { baseUrl: "y" } },
    });
    const removed = removeProviderEntry(existing, PHANTOOPS_PROVIDER);
    expect(removed.ok).toBe(true);
    if (removed.ok && removed.text) {
      const doc = JSON.parse(removed.text);
      expect(doc.providers.ollama).toEqual({ baseUrl: "http://x" });
      expect(doc.providers[PHANTOOPS_PROVIDER]).toBeUndefined();
    }
  });

  test("is a no-op when the file, the providers key or our entry is absent", () => {
    expect(removeProviderEntry(undefined, PHANTOOPS_PROVIDER)).toEqual({ ok: true });
    expect(removeProviderEntry("{}", PHANTOOPS_PROVIDER)).toEqual({ ok: true });
    expect(
      removeProviderEntry('{"providers":{"ollama":{}}}', PHANTOOPS_PROVIDER),
    ).toEqual({ ok: true });
  });

  test("refuses to rewrite an unparseable document", () => {
    const removed = removeProviderEntry("nope", PHANTOOPS_PROVIDER);
    expect(removed.ok).toBe(false);
  });
});

describe("entryMatches — the drift check", () => {
  const want = buildProviderEntry({
    id: PHANTOOPS_PROVIDER,
    baseUrl: PHANTOOPS_DEFAULT_BASE_URL,
    models: ["phantomops/auto", "openrouter/foo"],
  });

  test("an identical entry needs no rewrite", () => {
    expect(entryMatches(want, want)).toBe(true);
  });

  test("a missing entry never matches", () => {
    expect(entryMatches(undefined, want)).toBe(false);
  });

  test("a moved endpoint, a different api flavour or a lost key reference drift", () => {
    expect(entryMatches({ ...want, baseUrl: "https://old.box/api/v1" }, want)).toBe(false);
    expect(entryMatches({ ...want, api: "anthropic" as never }, want)).toBe(false);
    expect(entryMatches({ ...want, apiKey: NO_KEY_PLACEHOLDER }, want)).toBe(false);
  });

  test("a model the entry is missing drifts; extra models do not", () => {
    expect(entryMatches({ ...want, models: [{ id: "phantomops/auto" }] }, want)).toBe(false);
    expect(
      entryMatches({ ...want, models: [...want.models, { id: "extra/model" }] }, want),
    ).toBe(true);
  });
});

describe("writing the entry", () => {
  test("writes 0600 and is idempotent on a second identical call", async () => {
    const dir = await scratchAgentDir();
    const first = await writeCustomProviderEntry(
      dir,
      PHANTOOPS_PROVIDER,
      buildProviderEntry({ id: PHANTOOPS_PROVIDER, baseUrl: PHANTOOPS_DEFAULT_BASE_URL }),
    );
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.changed).toBe(true);

    const second = await writeCustomProviderEntry(
      dir,
      PHANTOOPS_PROVIDER,
      buildProviderEntry({ id: PHANTOOPS_PROVIDER, baseUrl: PHANTOOPS_DEFAULT_BASE_URL }),
    );
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.changed).toBe(false);

    const text = await readFile(modelsJsonPath(dir), "utf8");
    expect(JSON.parse(text).providers[PHANTOOPS_PROVIDER].apiKey).toBe("$PHANTOOPS_API_KEY");
    // No credential value anywhere in the file.
    expect(text).not.toContain("pok_");
  });

  test("ensure writes on drift, unions models and then leaves the file alone", async () => {
    const dir = await scratchAgentDir();
    const created = await ensureCustomProviderEntry(dir, PHANTOOPS_PROVIDER, {
      baseUrl: PHANTOOPS_DEFAULT_BASE_URL,
      models: ["phantomops/auto", "openrouter/foo"],
      keyAvailable: true,
    });
    expect(created.ok && created.changed).toBe(true);

    // A spawn-time refresh (no models) must NOT shrink the operator's list.
    const refreshed = await ensureCustomProviderEntry(dir, PHANTOOPS_PROVIDER, {
      baseUrl: PHANTOOPS_DEFAULT_BASE_URL,
      keyAvailable: true,
    });
    expect(refreshed.ok && refreshed.changed).toBe(false);
    const entry = await readCustomProviderEntry(dir, PHANTOOPS_PROVIDER);
    expect(entry?.models.map((m) => m.id)).toEqual(["phantomops/auto", "openrouter/foo"]);

    // A moved endpoint DOES rewrite, and still keeps the models.
    const moved = await ensureCustomProviderEntry(dir, PHANTOOPS_PROVIDER, {
      baseUrl: "https://dev.box/api/v1",
      keyAvailable: true,
    });
    expect(moved.ok && moved.changed).toBe(true);
    const after = await readCustomProviderEntry(dir, PHANTOOPS_PROVIDER);
    expect(after?.baseUrl).toBe("https://dev.box/api/v1");
    expect(after?.models.map((m) => m.id)).toEqual(["phantomops/auto", "openrouter/foo"]);
  });

  test("ensure does not touch a foreign provider's entry", async () => {
    const dir = await scratchAgentDir();
    await writeCustomProviderEntry(dir, PHANTOOPS_PROVIDER, {
      baseUrl: PHANTOOPS_DEFAULT_BASE_URL,
      api: "openai-completions",
      apiKey: "$PHANTOOPS_API_KEY",
      models: [{ id: "phantomops/auto" }],
    });
    await ensureCustomProviderEntry(dir, OPENAI_COMPATIBLE_PROVIDER, {
      baseUrl: "http://localhost:11434/v1",
      models: ["llama3"],
      keyAvailable: false,
    });
    const doc = JSON.parse(await readFile(modelsJsonPath(dir), "utf8"));
    expect(Object.keys(doc.providers).sort()).toEqual([
      OPENAI_COMPATIBLE_PROVIDER,
      PHANTOOPS_PROVIDER,
    ]);
    expect(doc.providers[OPENAI_COMPATIBLE_PROVIDER].apiKey).toBe(NO_KEY_PLACEHOLDER);
  });

  test("a refused document is reported, not overwritten", async () => {
    const dir = await scratchAgentDir();
    const path = modelsJsonPath(dir);
    await writeCustomProviderEntry(dir, PHANTOOPS_PROVIDER, buildProviderEntry({
      id: PHANTOOPS_PROVIDER,
      baseUrl: PHANTOOPS_DEFAULT_BASE_URL,
    }));
    // Corrupt it, then try again.
    await Bun.write(path, "{ broken");
    const res = await ensureCustomProviderEntry(dir, PHANTOOPS_PROVIDER, {
      baseUrl: PHANTOOPS_DEFAULT_BASE_URL,
    });
    expect(res.ok).toBe(false);
    expect(await readFile(path, "utf8")).toBe("{ broken");
  });

  test("clear removes ours, keeps foreign providers, and no-ops when absent", async () => {
    const dir = await scratchAgentDir();
    await writeCustomProviderEntry(dir, PHANTOOPS_PROVIDER, buildProviderEntry({
      id: PHANTOOPS_PROVIDER,
      baseUrl: PHANTOOPS_DEFAULT_BASE_URL,
    }));
    const ext = JSON.parse(await readFile(modelsJsonPath(dir), "utf8"));
    ext.providers.ollama = { baseUrl: "http://localhost:11434/v1" };
    await Bun.write(modelsJsonPath(dir), JSON.stringify(ext));

    const cleared = await clearCustomProviderEntry(dir, PHANTOOPS_PROVIDER);
    expect(cleared.ok && cleared.changed).toBe(true);
    const doc = JSON.parse(await readFile(modelsJsonPath(dir), "utf8"));
    expect(doc.providers[PHANTOOPS_PROVIDER]).toBeUndefined();
    expect(doc.providers.ollama).toBeDefined();

    const again = await clearCustomProviderEntry(dir, PHANTOOPS_PROVIDER);
    expect(again.ok && again.changed).toBe(false);
  });
});


/**
 * Which stored endpoint a wizard may reuse (review, Kai). Both wizards fed
 * `[harnesses.pi.routing].base_url` to whichever custom provider was chosen, so
 * selecting PhantomOps after a self-hosted box announced and PERSISTED the old
 * inference URL — and then sent the new personal token there.
 */
describe("storedBaseUrlForProvider", () => {
  const STORED = "http://old-inference.example/v1";

  test("the endpoint is reused while the provider is unchanged", () => {
    expect(storedBaseUrlForProvider(OPENAI_COMPATIBLE_PROVIDER, OPENAI_COMPATIBLE_PROVIDER, STORED))
      .toBe(STORED);
  });

  test("a provider SWITCH drops it — the new provider starts from its own default", () => {
    expect(storedBaseUrlForProvider(PHANTOOPS_PROVIDER, OPENAI_COMPATIBLE_PROVIDER, STORED))
      .toBeUndefined();
    expect(
      resolveCustomProviderBaseUrl(
        PHANTOOPS_PROVIDER,
        storedBaseUrlForProvider(PHANTOOPS_PROVIDER, OPENAI_COMPATIBLE_PROVIDER, STORED),
      ),
    ).toBe(PHANTOOPS_DEFAULT_BASE_URL);
  });

  test("switching away to no provider, or to a catalogue provider, drops it too", () => {
    expect(storedBaseUrlForProvider("", OPENAI_COMPATIBLE_PROVIDER, STORED)).toBeUndefined();
    expect(storedBaseUrlForProvider("openrouter", OPENAI_COMPATIBLE_PROVIDER, STORED)).toBeUndefined();
  });

  test("'no provider' before and after counts as unchanged", () => {
    expect(storedBaseUrlForProvider(undefined, undefined, undefined)).toBeUndefined();
    expect(storedBaseUrlForProvider("", undefined, undefined)).toBeUndefined();
  });
});

/**
 * One definition of "may run with no credential", shared by the wizard (which
 * decides whether the key prompt can be left empty) and the native pre-spawn
 * guard (which decides whether a missing key is fatal). The two disagreeing is
 * exactly how a keyless brain saved cleanly and failed its first turn.
 */
describe("customProviderAllowsKeyless", () => {
  test("only the self-hosted OpenAI-compatible provider may run keyless", () => {
    expect(customProviderAllowsKeyless(OPENAI_COMPATIBLE_PROVIDER)).toBe(true);
    expect(customProviderAllowsKeyless(PHANTOOPS_PROVIDER)).toBe(false);
  });

  test("catalogue providers and 'no provider' are never keyless", () => {
    expect(customProviderAllowsKeyless("openrouter")).toBe(false);
    expect(customProviderAllowsKeyless(undefined)).toBe(false);
    expect(customProviderAllowsKeyless("")).toBe(false);
  });
});

/**
 * The `models.json` rollback image (review, Kai): the brain interview writes
 * provider entries, so "brain unchanged" has to be able to take them back —
 * including DELETING a file that did not exist before the interview.
 */
describe("snapshotModelsJson / restoreModelsJson", () => {
  test("an absent file snapshots as undefined and restoring REMOVES what was added", async () => {
    const dir = await scratchAgentDir();
    expect(await snapshotModelsJson(dir)).toBeUndefined();

    await writeCustomProviderEntry(dir, PHANTOOPS_PROVIDER, buildProviderEntry({
      id: PHANTOOPS_PROVIDER,
      baseUrl: PHANTOOPS_DEFAULT_BASE_URL,
    }));

    expect(await restoreModelsJson(dir, undefined)).toEqual({ ok: true });
    expect(await snapshotModelsJson(dir)).toBeUndefined();
  });

  test("an existing file comes back byte-identical, foreign providers included", async () => {
    const dir = await scratchAgentDir();
    const original = `${JSON.stringify({ providers: { ollama: { baseUrl: "http://x/v1" } } }, null, 2)}\n`;
    await Bun.write(modelsJsonPath(dir), original);
    const image = await snapshotModelsJson(dir);

    await writeCustomProviderEntry(dir, OPENAI_COMPATIBLE_PROVIDER, buildProviderEntry({
      id: OPENAI_COMPATIBLE_PROVIDER,
      baseUrl: "http://localhost:11434/v1",
      models: ["llama3.1"],
    }));
    expect(await readFile(modelsJsonPath(dir), "utf8")).not.toBe(original);

    expect(await restoreModelsJson(dir, image)).toEqual({ ok: true });
    expect(await readFile(modelsJsonPath(dir), "utf8")).toBe(original);
  });
});
