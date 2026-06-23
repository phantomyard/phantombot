/**
 * Tests for the managed Pi capability-routing extension provisioner.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureRoutingExtension,
  hasRoutableCapability,
  removeRoutingExtension,
  routingExtensionStatus,
} from "../src/lib/piExtensionProvision.ts";
import { PI_EXTENSION_FILES } from "../src/lib/piExtensionAssets.generated.ts";

let home: string;
const EXT_REL = [".pi", "agent", "extensions", "capability-routing"];

function extDir(h: string): string {
  return join(h, ...EXT_REL);
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
    const r = await ensureRoutingExtension(routing, { home });

    // coding model set + progress unspecified ⇒ on by default, so the baked
    // models gain codingProgress: true.
    const expectedModels = { ...routing, codingProgress: true };

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

    // routing.json holds exactly the provided models (+ default-on progress).
    const routingJson = JSON.parse(
      await readFile(join(extDir(home), "routing.json"), "utf8"),
    );
    expect(routingJson).toEqual(expectedModels);

    // Marker exists.
    expect(existsSync(join(extDir(home), ".phantombot-managed"))).toBe(true);
  });

  test("only the set capability is written to routing.json (coding only)", async () => {
    // coding capability set, image unset → coder registers, look_at_image does not.
    await ensureRoutingExtension(
      { primaryModel: "gpt-5.2", codingModel: "qwen-coder" },
      { home },
    );
    const routingJson = JSON.parse(
      await readFile(join(extDir(home), "routing.json"), "utf8"),
    );
    expect(routingJson).toEqual({
      primaryModel: "gpt-5.2",
      codingModel: "qwen-coder",
      // coding model set + progress unspecified ⇒ on by default
      codingProgress: true,
    });
    expect("imageModel" in routingJson).toBe(false);
  });

  test("bakes codingProgress only when on AND a coding model is set", async () => {
    await ensureRoutingExtension(
      { primaryModel: "gpt-5.2", codingModel: "qwen-coder", codingProgress: true },
      { home },
    );
    const routingJson = JSON.parse(
      await readFile(join(extDir(home), "routing.json"), "utf8"),
    );
    expect(routingJson).toEqual({
      primaryModel: "gpt-5.2",
      codingModel: "qwen-coder",
      codingProgress: true,
    });
  });

  test("explicit progress off bakes false; no coding model omits the key", async () => {
    // progress explicitly off ⇒ baked as false (must persist so the extension,
    // which defaults absent ⇒ on, can see the override and stay quiet)
    await ensureRoutingExtension(
      { primaryModel: "gpt-5.2", codingModel: "qwen-coder", codingProgress: false },
      { home },
    );
    let json = JSON.parse(
      await readFile(join(extDir(home), "routing.json"), "utf8"),
    );
    expect(json.codingProgress).toBe(false);

    // progress true but image-only (no coding model) ⇒ key omitted (decoupled)
    await ensureRoutingExtension(
      { primaryModel: "gpt-5.2", imageModel: "gpt-4o", codingProgress: true },
      { home },
    );
    json = JSON.parse(
      await readFile(join(extDir(home), "routing.json"), "utf8"),
    );
    expect("codingProgress" in json).toBe(false);
  });

  test("image-only capability stamps the dir (coding unset)", async () => {
    const r = await ensureRoutingExtension(
      { primaryModel: "gpt-5.2", imageModel: "gpt-4o" },
      { home },
    );
    expect(r.action).toBe("created");
    const routingJson = JSON.parse(
      await readFile(join(extDir(home), "routing.json"), "utf8"),
    );
    expect(routingJson).toEqual({ primaryModel: "gpt-5.2", imageModel: "gpt-4o" });
    expect("codingModel" in routingJson).toBe(false);
  });

  test("no routable capability (primaryModel only) does not create the dir", async () => {
    const r = await ensureRoutingExtension({ primaryModel: "gpt-5.2" }, { home });
    expect(r.action).toBe("absent");
    expect(r.wrote).toEqual([]);
    expect(existsSync(extDir(home))).toBe(false);
  });

  test("undefined routing does not create the dir (action 'absent')", async () => {
    const r = await ensureRoutingExtension(undefined, { home });
    expect(r.action).toBe("absent");
    expect(existsSync(extDir(home))).toBe(false);
  });

  test("blank model strings count as unset (whitespace trimmed)", async () => {
    const r = await ensureRoutingExtension(
      { primaryModel: "gpt-5.2", codingModel: "   ", imageModel: "" },
      { home },
    );
    expect(r.action).toBe("absent");
    expect(existsSync(extDir(home))).toBe(false);
  });

  test("dropping all capabilities removes a previously-stamped dir (action 'removed')", async () => {
    await ensureRoutingExtension(
      { primaryModel: "gpt-5.2", codingModel: "qwen-coder" },
      { home },
    );
    expect(existsSync(extDir(home))).toBe(true);

    const r = await ensureRoutingExtension({ primaryModel: "gpt-5.2" }, { home });
    expect(r.action).toBe("removed");
    expect(existsSync(extDir(home))).toBe(false);
  });

  test("removing one capability keeps the dir and re-bakes routing.json", async () => {
    await ensureRoutingExtension(
      { primaryModel: "gpt-5.2", imageModel: "gpt-4o", codingModel: "qwen-coder" },
      { home },
    );
    // Drop image, keep coding → dir stays, routing.json loses imageModel.
    const r = await ensureRoutingExtension(
      { primaryModel: "gpt-5.2", codingModel: "qwen-coder" },
      { home },
    );
    expect(r.action).toBe("updated");
    expect(existsSync(extDir(home))).toBe(true);
    const routingJson = JSON.parse(
      await readFile(join(extDir(home), "routing.json"), "utf8"),
    );
    expect(routingJson).toEqual({
      primaryModel: "gpt-5.2",
      codingModel: "qwen-coder",
      // coding model set + progress unspecified ⇒ on by default
      codingProgress: true,
    });
  });

  test("second run on identical input returns action 'unchanged'", async () => {
    const routing = { primaryModel: "gpt-5.2", codingModel: "qwen-coder" };
    await ensureRoutingExtension(routing, { home });
    const second = await ensureRoutingExtension(routing, { home });
    expect(second.action).toBe("unchanged");
    expect(second.wrote).toEqual([]);
  });

  test("mutating a stamped file then re-running restores it (action 'updated')", async () => {
    const routing = { primaryModel: "gpt-5.2", imageModel: "gpt-4o" };
    await ensureRoutingExtension(routing, { home });

    const toolsPath = join(extDir(home), "tools.ts");
    const managed = await readFile(toolsPath, "utf8");
    await writeFile(toolsPath, "// tampered\n", "utf8");

    const r = await ensureRoutingExtension(routing, { home });
    expect(r.action).toBe("updated");
    expect(r.wrote).toContain("tools.ts");
    // Content restored to the managed version.
    expect(await readFile(toolsPath, "utf8")).toBe(managed);
  });
});

describe("routingExtensionStatus", () => {
  test("should-exist but missing on a fresh temp home → drifted", async () => {
    const status = await routingExtensionStatus({ codingModel: "x" }, { home });
    expect(status.shouldExist).toBe(true);
    expect(status.present).toBe(false);
    expect(status.drifted).toBe(true);
    expect(status.dir).toBe(extDir(home));
  });

  test("no capability + fresh home → correctly absent (not drifted)", async () => {
    const status = await routingExtensionStatus({ primaryModel: "x" }, { home });
    expect(status.shouldExist).toBe(false);
    expect(status.present).toBe(false);
    expect(status.drifted).toBe(false);
  });

  test("present + not drifted after a clean provision", async () => {
    const routing = { primaryModel: "gpt-5.2", codingModel: "qwen-coder" };
    await ensureRoutingExtension(routing, { home });
    const status = await routingExtensionStatus(routing, { home });
    expect(status.shouldExist).toBe(true);
    expect(status.present).toBe(true);
    expect(status.drifted).toBe(false);
  });

  test("reports drifted=true after a source file is mutated", async () => {
    const routing = { primaryModel: "gpt-5.2", codingModel: "qwen-coder" };
    await ensureRoutingExtension(routing, { home });
    await writeFile(join(extDir(home), "index.ts"), "// tampered\n", "utf8");
    const status = await routingExtensionStatus(routing, { home });
    expect(status.present).toBe(true);
    expect(status.drifted).toBe(true);
  });

  test("reports drifted=true when routing.json no longer matches desired", async () => {
    await ensureRoutingExtension({ codingModel: "qwen-coder" }, { home });
    // Ask about a different (still-capable) routing config → routing.json differs.
    const status = await routingExtensionStatus(
      { codingModel: "different-coder" },
      { home },
    );
    expect(status.shouldExist).toBe(true);
    expect(status.present).toBe(true);
    expect(status.drifted).toBe(true);
  });

  test("stamped, then all capabilities dropped → drifted (needs removal)", async () => {
    await ensureRoutingExtension({ codingModel: "qwen-coder" }, { home });
    const status = await routingExtensionStatus({ primaryModel: "x" }, { home });
    expect(status.shouldExist).toBe(false);
    expect(status.present).toBe(true);
    expect(status.drifted).toBe(true);
  });
});

describe("hasRoutableCapability", () => {
  test("true when image or coding set; false otherwise", () => {
    expect(hasRoutableCapability({ imageModel: "gpt-4o" })).toBe(true);
    expect(hasRoutableCapability({ codingModel: "qwen-coder" })).toBe(true);
    expect(hasRoutableCapability({ primaryModel: "gpt-5.2" })).toBe(false);
    expect(hasRoutableCapability(undefined)).toBe(false);
    // Blank/whitespace models do not count.
    expect(hasRoutableCapability({ codingModel: "  " })).toBe(false);
  });
});

describe("removeRoutingExtension", () => {
  test("removes a stamped dir; idempotent when already absent", async () => {
    await ensureRoutingExtension({ codingModel: "qwen-coder" }, { home });
    expect(existsSync(extDir(home))).toBe(true);

    const first = await removeRoutingExtension({ home });
    expect(first.removed).toBe(true);
    expect(existsSync(extDir(home))).toBe(false);

    const second = await removeRoutingExtension({ home });
    expect(second.removed).toBe(false);
  });
});
