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

    expect(r.action).toBe("created");
    expect(r.dir).toBe(extDir(home));
    expect(r.models).toEqual(routing);

    // Every embedded source file is present and carries the managed banner.
    for (const rel of Object.keys(PI_EXTENSION_FILES)) {
      const full = join(extDir(home), rel);
      expect(existsSync(full)).toBe(true);
      const content = await readFile(full, "utf8");
      expect(content).toContain("MANAGED BY PHANTOMBOT");
    }

    // routing.json holds exactly the provided models.
    const routingJson = JSON.parse(
      await readFile(join(extDir(home), "routing.json"), "utf8"),
    );
    expect(routingJson).toEqual(routing);

    // Marker exists.
    expect(existsSync(join(extDir(home), ".phantombot-managed"))).toBe(true);
  });

  test("only defined routing fields are written to routing.json", async () => {
    await ensureRoutingExtension({ primaryModel: "gpt-5.2" }, { home });
    const routingJson = JSON.parse(
      await readFile(join(extDir(home), "routing.json"), "utf8"),
    );
    expect(routingJson).toEqual({ primaryModel: "gpt-5.2" });
    expect("imageModel" in routingJson).toBe(false);
    expect("codingModel" in routingJson).toBe(false);
  });

  test("undefined routing writes an empty routing.json", async () => {
    await ensureRoutingExtension(undefined, { home });
    const routingJson = JSON.parse(
      await readFile(join(extDir(home), "routing.json"), "utf8"),
    );
    expect(routingJson).toEqual({});
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
  test("present=false on a fresh temp home", async () => {
    const status = await routingExtensionStatus({ primaryModel: "x" }, { home });
    expect(status.present).toBe(false);
    expect(status.drifted).toBe(true);
    expect(status.dir).toBe(extDir(home));
  });

  test("present + not drifted after a clean provision", async () => {
    const routing = { primaryModel: "gpt-5.2", codingModel: "qwen-coder" };
    await ensureRoutingExtension(routing, { home });
    const status = await routingExtensionStatus(routing, { home });
    expect(status.present).toBe(true);
    expect(status.drifted).toBe(false);
  });

  test("reports drifted=true after a source file is mutated", async () => {
    const routing = { primaryModel: "gpt-5.2" };
    await ensureRoutingExtension(routing, { home });
    await writeFile(join(extDir(home), "index.ts"), "// tampered\n", "utf8");
    const status = await routingExtensionStatus(routing, { home });
    expect(status.present).toBe(true);
    expect(status.drifted).toBe(true);
  });

  test("reports drifted=true when routing.json no longer matches desired", async () => {
    await ensureRoutingExtension({ primaryModel: "gpt-5.2" }, { home });
    // Ask about a different routing config → desired routing.json differs.
    const status = await routingExtensionStatus(
      { primaryModel: "different" },
      { home },
    );
    expect(status.present).toBe(true);
    expect(status.drifted).toBe(true);
  });
});
