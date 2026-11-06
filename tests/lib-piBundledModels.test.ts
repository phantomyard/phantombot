/**
 * Pi's bundled model list is the fallback that keeps a provider's model picker
 * from coming back empty (OpenCode Go, Z.ai, MiniMax, ... before #782).
 */

import { describe, expect, test } from "bun:test";
import { bundledProviderModels } from "../src/lib/piBundledModels.ts";
import { PI_PROVIDER_CATALOG } from "../src/lib/piModels.ts";
import { customProviderSpec } from "../src/lib/piCustomProvider.ts";
import { providerKeyCheckable } from "../src/lib/providerKeyProbe.ts";

describe("bundledProviderModels", () => {
  test("every catalog provider either has a key check or a bundled model list", async () => {
    const empty: string[] = [];
    for (const p of PI_PROVIDER_CATALOG) {
      if (customProviderSpec(p.id)) continue; // models come from the operator's own server
      if (providerKeyCheckable(p.id)) continue;
      if ((await bundledProviderModels(p.id)).length === 0) empty.push(p.id);
    }
    expect(empty).toEqual([]);
  });

  test("rows carry the catalog id and Pi's image capability", async () => {
    const rows = await bundledProviderModels("minimax");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.provider === "minimax")).toBe(true);
    expect(rows.some((r) => r.supportsImages)).toBe(true);
    expect(rows.some((r) => !r.supportsImages)).toBe(true);
  });

  test("Azure maps to Pi's 'azure' catalogue", async () => {
    expect((await bundledProviderModels("azure-openai-responses")).length).toBeGreaterThan(0);
  });

  test("an unknown provider is [] rather than a throw", async () => {
    expect(await bundledProviderModels("no-such-provider")).toEqual([]);
  });
});
