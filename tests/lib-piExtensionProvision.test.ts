/**
 * Tests for the managed Pi capability-routing extension provisioner.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import {
  ensureRoutingExtension,
  hasRoutableCapability,
  hostDesiredRouting,
  removeRoutingExtension,
  rosterLayers,
  routingExtensionStatus,
} from "../src/lib/piExtensionProvision.ts";
import { PI_EXTENSION_FILES } from "../src/lib/piExtensionAssets.generated.ts";

let home: string;
const EXT_REL = [".pi", "agent", "extensions", "capability-routing"];

// The provision seam is now an AGENT dir (lib/nativeAgentDir.ts) instead of a
// home; pointing it at home/.pi/agent keeps every asserted path identical.
function extDir(h: string): string {
  return join(h, ...EXT_REL);
}
function agentDir(h: string): string {
  return join(h, ".pi", "agent");
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "phantombot-piext-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("ensureRoutingExtension", () => {
  test("fresh temp home: creates all source files + routing.json + marker", async () => {
    const routing = {
      primaryModel: "deepseek-v4-pro",
      imageModel: "gpt-4o",
      codingModel: "gpt-5.2-codex",
    };
    const r = await ensureRoutingExtension(routing, { agentDir: agentDir(home) });

    // The coding model is NOT baked into routing.json — it drives the per-turn
    // coding-brain swap, not any tool the extension registers.
    const expectedModels = {
      primaryModel: "deepseek-v4-pro",
      imageModel: "gpt-4o",
    };

    expect(r.action).toBe("created");
    expect(r.dir).toBe(extDir(home));
    expect(r.models).toEqual(expectedModels);

    // Every embedded source file is present and carries the managed banner.
    for (const rel of Object.keys(PI_EXTENSION_FILES)) {
      const full = join(extDir(home), rel);
      expect(existsSync(full)).toBe(true);
      const content = await readFile(full, "utf8");
      expect(content).toContain("MANAGED BY PHANTOMBOT");
    }

    // routing.json holds exactly the primary + image models (no coding fields).
    const routingJson = JSON.parse(
      await readFile(join(extDir(home), "routing.json"), "utf8"),
    );
    expect(routingJson).toEqual(expectedModels);

    // Marker exists.
    expect(existsSync(join(extDir(home), ".phantombot-managed"))).toBe(true);
  });

  test("coding model alone (no image) does not create the dir", async () => {
    // The coding model drives the swap, not the extension's look_at_image tool,
    // so it no longer justifies provisioning the managed dir.
    const r = await ensureRoutingExtension(
      { primaryModel: "gpt-5.2", codingModel: "qwen-coder" },
      { agentDir: agentDir(home) },
    );
    expect(r.action).toBe("absent");
    expect(r.wrote).toEqual([]);
    expect(existsSync(extDir(home))).toBe(false);
  });

  test("image capability stamps the dir; coding fields are not baked", async () => {
    const r = await ensureRoutingExtension(
      { primaryModel: "gpt-5.2", imageModel: "gpt-4o", codingModel: "qwen-coder" },
      { agentDir: agentDir(home) },
    );
    expect(r.action).toBe("created");
    const routingJson = JSON.parse(
      await readFile(join(extDir(home), "routing.json"), "utf8"),
    );
    expect(routingJson).toEqual({ primaryModel: "gpt-5.2", imageModel: "gpt-4o" });
    expect("codingModel" in routingJson).toBe(false);
    expect("codingProgress" in routingJson).toBe(false);
  });

  test("no routable capability (primaryModel only) does not create the dir", async () => {
    const r = await ensureRoutingExtension({ primaryModel: "gpt-5.2" }, { agentDir: agentDir(home) });
    expect(r.action).toBe("absent");
    expect(r.wrote).toEqual([]);
    expect(existsSync(extDir(home))).toBe(false);
  });

  test("undefined routing does not create the dir (action 'absent')", async () => {
    const r = await ensureRoutingExtension(undefined, { agentDir: agentDir(home) });
    expect(r.action).toBe("absent");
    expect(existsSync(extDir(home))).toBe(false);
  });

  test("blank model strings count as unset (whitespace trimmed)", async () => {
    const r = await ensureRoutingExtension(
      { primaryModel: "gpt-5.2", codingModel: "   ", imageModel: "" },
      { agentDir: agentDir(home) },
    );
    expect(r.action).toBe("absent");
    expect(existsSync(extDir(home))).toBe(false);
  });

  test("dropping the image model removes a previously-stamped dir (action 'removed')", async () => {
    await ensureRoutingExtension(
      { primaryModel: "gpt-5.2", imageModel: "gpt-4o" },
      { agentDir: agentDir(home) },
    );
    expect(existsSync(extDir(home))).toBe(true);

    const r = await ensureRoutingExtension(
      { primaryModel: "gpt-5.2", codingModel: "qwen-coder" },
      { agentDir: agentDir(home) },
    );
    expect(r.action).toBe("removed");
    expect(existsSync(extDir(home))).toBe(false);
  });

  test("second run on identical input returns action 'unchanged'", async () => {
    const routing = { primaryModel: "gpt-5.2", imageModel: "gpt-4o" };
    await ensureRoutingExtension(routing, { agentDir: agentDir(home) });
    const second = await ensureRoutingExtension(routing, { agentDir: agentDir(home) });
    expect(second.action).toBe("unchanged");
    expect(second.wrote).toEqual([]);
  });

  test("prunes a stale orphan file (e.g. agents/coder.md) left from a prior asset set", async () => {
    const routing = { primaryModel: "gpt-5.2", imageModel: "gpt-4o" };
    await ensureRoutingExtension(routing, { agentDir: agentDir(home) });

    // Simulate a host stamped by an OLDER phantombot whose embedded asset set
    // still shipped the coder agent file. It must NOT survive a re-stamp.
    const stalePath = join(extDir(home), "agents", "coder.md");
    await mkdir(join(extDir(home), "agents"), { recursive: true });
    await writeFile(stalePath, "<!-- stale coder agent -->\n", "utf8");
    expect(existsSync(stalePath)).toBe(true);

    const r = await ensureRoutingExtension(routing, { agentDir: agentDir(home) });
    expect(r.action).toBe("updated");
    expect(r.pruned).toContain("agents/coder.md");
    expect(existsSync(stalePath)).toBe(false);
    // The now-empty agents/ dir is cleaned up too.
    expect(existsSync(join(extDir(home), "agents"))).toBe(false);
    // Desired files are untouched.
    expect(existsSync(join(extDir(home), "routing.json"))).toBe(true);
  });

  test("a clean second run prunes nothing and stays 'unchanged'", async () => {
    const routing = { primaryModel: "gpt-5.2", imageModel: "gpt-4o" };
    await ensureRoutingExtension(routing, { agentDir: agentDir(home) });
    const second = await ensureRoutingExtension(routing, { agentDir: agentDir(home) });
    expect(second.action).toBe("unchanged");
    expect(second.pruned).toEqual([]);
  });

  test("mutating a stamped file then re-running restores it (action 'updated')", async () => {
    const routing = { primaryModel: "gpt-5.2", imageModel: "gpt-4o" };
    await ensureRoutingExtension(routing, { agentDir: agentDir(home) });

    const toolsPath = join(extDir(home), "tools.ts");
    const managed = await readFile(toolsPath, "utf8");
    await writeFile(toolsPath, "// tampered\n", "utf8");

    const r = await ensureRoutingExtension(routing, { agentDir: agentDir(home) });
    expect(r.action).toBe("updated");
    expect(r.wrote).toContain("tools.ts");
    // Content restored to the managed version.
    expect(await readFile(toolsPath, "utf8")).toBe(managed);
  });
});

describe("routingExtensionStatus", () => {
  test("should-exist but missing on a fresh temp home → drifted", async () => {
    const status = await routingExtensionStatus({ imageModel: "gpt-4o" }, { agentDir: agentDir(home) });
    expect(status.shouldExist).toBe(true);
    expect(status.present).toBe(false);
    expect(status.drifted).toBe(true);
    expect(status.dir).toBe(extDir(home));
  });

  test("no capability + fresh home → correctly absent (not drifted)", async () => {
    const status = await routingExtensionStatus({ primaryModel: "x" }, { agentDir: agentDir(home) });
    expect(status.shouldExist).toBe(false);
    expect(status.present).toBe(false);
    expect(status.drifted).toBe(false);
  });

  test("coding model alone does not make the extension should-exist", async () => {
    const status = await routingExtensionStatus({ codingModel: "x" }, { agentDir: agentDir(home) });
    expect(status.shouldExist).toBe(false);
    expect(status.present).toBe(false);
    expect(status.drifted).toBe(false);
  });

  test("present + not drifted after a clean provision", async () => {
    const routing = { primaryModel: "gpt-5.2", imageModel: "gpt-4o" };
    await ensureRoutingExtension(routing, { agentDir: agentDir(home) });
    const status = await routingExtensionStatus(routing, { agentDir: agentDir(home) });
    expect(status.shouldExist).toBe(true);
    expect(status.present).toBe(true);
    expect(status.drifted).toBe(false);
  });

  test("reports drifted=true after a source file is mutated", async () => {
    const routing = { primaryModel: "gpt-5.2", imageModel: "gpt-4o" };
    await ensureRoutingExtension(routing, { agentDir: agentDir(home) });
    await writeFile(join(extDir(home), "index.ts"), "// tampered\n", "utf8");
    const status = await routingExtensionStatus(routing, { agentDir: agentDir(home) });
    expect(status.present).toBe(true);
    expect(status.drifted).toBe(true);
  });

  test("reports drifted=true when a stale orphan file is present", async () => {
    const routing = { primaryModel: "gpt-5.2", imageModel: "gpt-4o" };
    await ensureRoutingExtension(routing, { agentDir: agentDir(home) });
    // Plant an orphan that is NOT in the desired set.
    await writeFile(join(extDir(home), "stale-orphan.md"), "x\n", "utf8");
    const status = await routingExtensionStatus(routing, { agentDir: agentDir(home) });
    expect(status.shouldExist).toBe(true);
    expect(status.present).toBe(true);
    expect(status.drifted).toBe(true);
  });

  test("reports drifted=true when routing.json no longer matches desired", async () => {
    await ensureRoutingExtension({ imageModel: "gpt-4o" }, { agentDir: agentDir(home) });
    // Ask about a different (still-capable) routing config → routing.json differs.
    const status = await routingExtensionStatus(
      { imageModel: "different-image" },
      { agentDir: agentDir(home) },
    );
    expect(status.shouldExist).toBe(true);
    expect(status.present).toBe(true);
    expect(status.drifted).toBe(true);
  });

  test("stamped, then the image model dropped → drifted (needs removal)", async () => {
    await ensureRoutingExtension({ imageModel: "gpt-4o" }, { agentDir: agentDir(home) });
    const status = await routingExtensionStatus({ primaryModel: "x" }, { agentDir: agentDir(home) });
    expect(status.shouldExist).toBe(false);
    expect(status.present).toBe(true);
    expect(status.drifted).toBe(true);
  });
});

describe("hasRoutableCapability", () => {
  test("true only when an image model is set", () => {
    expect(hasRoutableCapability({ imageModel: "gpt-4o" })).toBe(true);
    // A coding model drives the swap, not a tool — it does not justify the dir.
    expect(hasRoutableCapability({ codingModel: "qwen-coder" })).toBe(false);
    expect(hasRoutableCapability({ primaryModel: "gpt-5.2" })).toBe(false);
    expect(hasRoutableCapability(undefined)).toBe(false);
    // Blank/whitespace models do not count.
    expect(hasRoutableCapability({ imageModel: "  " })).toBe(false);
  });
});

describe("removeRoutingExtension", () => {
  test("removes a stamped dir; idempotent when already absent", async () => {
    await ensureRoutingExtension({ imageModel: "gpt-4o" }, { agentDir: agentDir(home) });
    expect(existsSync(extDir(home))).toBe(true);

    const first = await removeRoutingExtension({ agentDir: agentDir(home) });
    expect(first.removed).toBe(true);
    expect(existsSync(extDir(home))).toBe(false);

    const second = await removeRoutingExtension({ agentDir: agentDir(home) });
    expect(second.removed).toBe(false);
  });
});

describe("hostDesiredRouting", () => {
  // Layers only need the harnesses slice hostDesiredRouting reads; the full
  // Config shape (claude/pi tables etc.) is irrelevant to routing resolution.
  const layer = (harnesses: object) => ({ harnesses }) as Pick<
    Config,
    "harnesses"
  >;
  // Layer shapes mirror real per-persona config layers: lena's has only native
  // INSTANCE routings (no top-level table), kai's has a top-level routing.
  const lenaLayer = layer({
    chain: ["pi-primary", "pi-fallback"],
    instances: {
      "pi-primary": { type: "native", routing: { primaryModel: "glm-lena", imageModel: "glm-lena", provider: "openrouter" } },
      "pi-fallback": { type: "native", routing: { primaryModel: "kimi-lena", imageModel: "kimi-lena", provider: "openrouter" } },
    },
  });
  const kaiLayer = layer({
    chain: ["codex", "native"],
    pi: { routing: { primaryModel: "glm-kai", imageModel: "glm-kai", provider: "openrouter" } },
  });
  const jakeLayer = layer({
    chain: ["pi-primary"],
    instances: { "pi-primary": { type: "native", routing: { primaryModel: "gpt-jake", imageModel: "gpt-jake" } } },
  });

  test("default persona first: lena's instance routing wins over kai's top-level", () => {
    // The 2026-09-15 incident shape: lena's layer has no top-level routing
    // table, kai's does. The host desired state must still be lena's — the
    // roster order decides, not which layer happens to carry a top table.
    expect(hostDesiredRouting([lenaLayer, kaiLayer, jakeLayer])).toEqual({
      primaryModel: "glm-lena",
      imageModel: "glm-lena",
      provider: "openrouter",
    });
  });

  test("roster order is the contract: reordering layers changes the winner", () => {
    const kaiFirst = hostDesiredRouting([kaiLayer, lenaLayer]);
    expect(kaiFirst).toEqual({ primaryModel: "glm-kai", imageModel: "glm-kai", provider: "openrouter" });
    // Same layers, roster order flipped → different (but still deterministic)
    // winner. Callers MUST pass default persona first.
    expect(kaiFirst).not.toEqual(hostDesiredRouting([lenaLayer, kaiLayer]));
  });

  test("falls back to the first configured routing when nobody is capable", () => {
    const codingOnly = layer({
      chain: ["pi"],
      pi: { routing: { primaryModel: "x", codingModel: "qwen" } },
    });
    expect(hostDesiredRouting([codingOnly])).toEqual({ primaryModel: "x", codingModel: "qwen" });
  });

  test("no candidates at all → undefined (doctor then wants the dir absent)", () => {
    expect(hostDesiredRouting([layer({ chain: ["claude"] })])).toBeUndefined();
    expect(hostDesiredRouting([])).toBeUndefined();
  });

  test("a layer that cannot be read is simply skipped by the caller", () => {
    // kai's layer missing → jake's wins; no crash, still deterministic.
    expect(hostDesiredRouting([lenaLayer, jakeLayer])).toEqual({
      primaryModel: "glm-lena",
      imageModel: "glm-lena",
      provider: "openrouter",
    });
  });
});

describe("rosterLayers", () => {
  // Shapes mirror the real rig: the default persona's layer carries native
  // INSTANCE routings, kai's carries a top-level routing table. Cast like the
  // doctor suite does — the harnesses slice is all the code reads.
  const defaultLayer = {
    defaultPersona: "phantom",
    autostartPersonas: ["kai", "jake"],
    personaLayer: "phantom",
    harnesses: {
      chain: ["pi-primary", "pi-fallback"],
      instances: {
        "pi-primary": { type: "native", routing: { primaryModel: "glm-default", imageModel: "glm-default", provider: "openrouter" } },
        "pi-fallback": { type: "native", routing: { primaryModel: "kimi-default", imageModel: "kimi-default", provider: "openrouter" } },
      },
    },
  } as unknown as Parameters<typeof rosterLayers>[0];
  const kaiLayer = {
    defaultPersona: "phantom",
    autostartPersonas: ["kai", "jake"],
    personaLayer: "kai",
    harnesses: {
      chain: ["codex", "native"],
      pi: { routing: { primaryModel: "glm-kai", imageModel: "glm-kai", provider: "openrouter" } },
    },
  } as unknown as Parameters<typeof rosterLayers>[0];
  // Minimal layer the seam stubs return — cast, only `harnesses.chain` is read.
  const bareLayer = { harnesses: { chain: ["claude"] } } as unknown as Pick<
    Config,
    "harnesses"
  >;

  test("production shape: the held layer leads, non-defaults come from the seam", async () => {
    const loaded: string[] = [];
    const layers = await rosterLayers(defaultLayer, async (name) => {
      loaded.push(name);
      return kaiLayer;
    });
    // Default persona first (its layer is `config` itself — never re-read),
    // then autostart order.
    expect(layers[0]).toBe(defaultLayer);
    expect(loaded).toEqual(["kai", "jake"]);
    expect(layers).toHaveLength(3);
  });

  test("REGRESSION (#565): an injected non-default layer never drops the default persona", async () => {
    // The old inline walk skipped BOTH `personaLayer` and `defaultPersona`
    // roster entries while leading with `config` — so with kai's layer
    // injected, phantom (the default) silently vanished from the roster and
    // kai's top-level routing would have won the stamp.
    const loaded: string[] = [];
    const layers = await rosterLayers(kaiLayer, async (name) => {
      loaded.push(name);
      if (name === "phantom") return defaultLayer;
      return bareLayer;
    });
    expect(loaded).toContain("phantom");
    expect(layers[0]).toBe(defaultLayer); // default leads, not the injection
    expect(layers[1]).toBe(kaiLayer); // the injected layer serves its own persona
  });

  test("an unset personaLayer (hand-built fixture) is treated as the default's layer", async () => {
    const loaded: string[] = [];
    const noLayerMarker = {
      ...defaultLayer,
      personaLayer: undefined,
    } as unknown as Parameters<typeof rosterLayers>[0];
    const layers = await rosterLayers(noLayerMarker, async (name) => {
      loaded.push(name);
      return bareLayer;
    });
    expect(layers[0]).toBe(noLayerMarker);
    expect(loaded).toEqual(["kai", "jake"]);
  });

  test("an unreadable persona drops out without throwing", async () => {
    const layers = await rosterLayers(defaultLayer, async (name) => {
      if (name === "kai") throw new Error("config.toml unreadable");
      return bareLayer;
    });
    expect(layers[0]).toBe(defaultLayer);
    expect(layers).toHaveLength(2); // phantom + jake; kai gone, no crash
  });

  test("duplicate roster entries are deduped", async () => {
    const dup = {
      ...defaultLayer,
      autostartPersonas: ["phantom", "kai", "kai"],
    } as unknown as Parameters<typeof rosterLayers>[0];
    const loaded: string[] = [];
    const layers = await rosterLayers(dup, async (name) => {
      loaded.push(name);
      return bareLayer;
    });
    expect(loaded).toEqual(["kai"]);
    expect(layers).toHaveLength(2);
  });
});
