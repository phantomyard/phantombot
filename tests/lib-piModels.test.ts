import { describe, expect, test } from "bun:test";
import {
  findModel,
  listPiModels,
  parsePiModels,
  PI_PROVIDER_CATALOG,
  primaryIsMultimodal,
  providerChoices,
  providerEnvVar,
} from "../src/lib/piModels.ts";

// A trimmed but faithful sample of real `pi --list-models` output: a banner
// line before the header, blank lines, the `~`-prefixed openrouter aliases,
// and a mix of yes/no in the images column.
const SAMPLE = `pi 0.79.1

provider    model                          context  max-out  thinking  images
deepseek    deepseek-v4-flash              1M       384K     yes       no
openai      gpt-4                          8.2K     8.2K     no        no
openai      gpt-5.2                        400K     128K     yes       yes
openrouter  ~anthropic/claude-opus-latest  1M       128K     yes       yes
openrouter  amazon/nova-micro-v1           128K     5.1K     no        no
`;

describe("parsePiModels", () => {
  test("parses provider, model and image capability", () => {
    const models = parsePiModels(SAMPLE);
    expect(models).toHaveLength(5);
    expect(models[0]).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      supportsImages: false,
    });
    const gpt = findModel(models, "gpt-5.2");
    expect(gpt?.supportsImages).toBe(true);
  });

  test("preserves the ~ prefix on openrouter aliases verbatim", () => {
    const models = parsePiModels(SAMPLE);
    const opus = findModel(models, "~anthropic/claude-opus-latest");
    expect(opus).toBeDefined();
    expect(opus?.supportsImages).toBe(true);
  });

  test("reads the images column positionally (last token)", () => {
    const models = parsePiModels(SAMPLE);
    expect(findModel(models, "gpt-4")?.supportsImages).toBe(false);
    expect(findModel(models, "amazon/nova-micro-v1")?.supportsImages).toBe(false);
  });

  test("returns [] when the header is absent (output changed / pi missing)", () => {
    expect(parsePiModels("some unrelated\noutput\n")).toEqual([]);
    expect(parsePiModels("")).toEqual([]);
  });

  test("skips blank lines and short/wrapped rows", () => {
    const text = `provider model context max-out thinking images
openai gpt-5.2 400K 128K yes yes

wrapped-continuation
`;
    const models = parsePiModels(text);
    expect(models).toHaveLength(1);
    expect(models[0]?.model).toBe("gpt-5.2");
  });
});

describe("primaryIsMultimodal", () => {
  test("true when the primary supports images", () => {
    const models = parsePiModels(SAMPLE);
    expect(primaryIsMultimodal(models, "gpt-5.2")).toBe(true);
  });

  test("false when the primary is text-only", () => {
    const models = parsePiModels(SAMPLE);
    expect(primaryIsMultimodal(models, "gpt-4")).toBe(false);
  });

  test("false (conservative) when the primary is unknown", () => {
    const models = parsePiModels(SAMPLE);
    expect(primaryIsMultimodal(models, "not-a-real-model")).toBe(false);
  });
});

describe("listPiModels", () => {
  test("parses via an injected runner", async () => {
    const models = await listPiModels("pi", async () => ({
      exitCode: 0,
      stdout: SAMPLE,
    }));
    expect(models).toHaveLength(5);
    expect(findModel(models, "gpt-5.2")?.supportsImages).toBe(true);
  });

  test("returns [] on non-zero exit", async () => {
    const models = await listPiModels("pi", async () => ({
      exitCode: 1,
      stdout: SAMPLE,
    }));
    expect(models).toEqual([]);
  });

  test("returns [] when the runner throws (pi not installed)", async () => {
    const models = await listPiModels("pi", async () => {
      throw new Error("ENOENT");
    });
    expect(models).toEqual([]);
  });

  test("passes extraEnv through to the runner (post-key refresh)", async () => {
    // The wizard refreshes the catalog after taking a key by injecting the
    // provider's NATIVE env var — `--list-models` ignores --api-key. Pin that
    // the value actually reaches the runner.
    let seen: Record<string, string> | undefined;
    await listPiModels(
      "pi",
      async (_bin, extraEnv) => {
        seen = extraEnv;
        return { exitCode: 0, stdout: SAMPLE };
      },
      { OPENROUTER_API_KEY: "sk-test" },
    );
    expect(seen).toEqual({ OPENROUTER_API_KEY: "sk-test" });
  });

  test("extraEnv is undefined when not supplied (inherit, as before)", async () => {
    let seen: Record<string, string> | undefined | "unset" = "unset";
    await listPiModels("pi", async (_bin, extraEnv) => {
      seen = extraEnv;
      return { exitCode: 0, stdout: SAMPLE };
    });
    expect(seen).toBeUndefined();
  });
});

describe("providerChoices", () => {
  // THE fresh-install regression: `pi --list-models` lists nothing until Pi
  // already holds a key, so deriving providers from it alone left the picker
  // empty exactly when the operator came to add their first key.
  test("offers the full catalog when pi lists no models (fresh install)", () => {
    const choices = providerChoices([]);
    expect(choices.length).toBe(PI_PROVIDER_CATALOG.length);
    expect(choices.map((c) => c.id)).toContain("openrouter");
    expect(choices.map((c) => c.id)).toContain("anthropic");
    expect(choices.every((c) => c.hasModels === false)).toBe(true);
  });

  test("marks providers pi already has models for", () => {
    const choices = providerChoices(parsePiModels(SAMPLE));
    const keyed = choices.filter((c) => c.hasModels).map((c) => c.id);
    expect(keyed.sort()).toEqual(["deepseek", "openai", "openrouter"]);
  });

  test("keyed providers sort first, then the rest by label", () => {
    const choices = providerChoices(parsePiModels(SAMPLE));
    const firstUnkeyed = choices.findIndex((c) => !c.hasModels);
    expect(choices.slice(0, firstUnkeyed).every((c) => c.hasModels)).toBe(true);
    expect(choices.slice(firstUnkeyed).every((c) => !c.hasModels)).toBe(true);
    // Keyed block is label-sorted: DeepSeek, OpenAI, OpenRouter.
    expect(choices.slice(0, 3).map((c) => c.label)).toEqual([
      "DeepSeek",
      "OpenAI",
      "OpenRouter",
    ]);
  });

  test("includes live providers missing from the catalog, labelled by id", () => {
    const choices = providerChoices([
      { provider: "some-new-provider", model: "m1", supportsImages: false },
    ]);
    const found = choices.find((c) => c.id === "some-new-provider");
    expect(found).toEqual({
      id: "some-new-provider",
      label: "some-new-provider",
      hasModels: true,
    });
  });

  test("never duplicates a provider that is both catalogued and live", () => {
    const choices = providerChoices(parsePiModels(SAMPLE));
    const ids = choices.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("providerEnvVar", () => {
  test("maps catalog providers to their native pi env var", () => {
    expect(providerEnvVar("openrouter")).toBe("OPENROUTER_API_KEY");
    // Pi's provider id is `google` while its docs label is "Google Gemini" —
    // the id is what --provider takes, the var is what --list-models reads.
    expect(providerEnvVar("google")).toBe("GEMINI_API_KEY");
    expect(providerEnvVar("huggingface")).toBe("HF_TOKEN");
  });

  test("undefined for an unknown provider (refresh is skipped)", () => {
    expect(providerEnvVar("some-new-provider")).toBeUndefined();
  });
});
