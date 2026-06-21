import { describe, expect, test } from "bun:test";
import {
  findModel,
  listPiModels,
  parsePiModels,
  primaryIsMultimodal,
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
});
