/**
 * The pi engine embedded in the phantombot binary (the `native` harness).
 *
 * Pins the contract the harness and the release build rely on: the exact pi
 * pin, the self-exec argv, the attribution (native only — it lives in the
 * `__pi` entry, which only native spawns), the extracted PI_PACKAGE_DIR assets,
 * and that the real engine actually runs through `__pi`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import {
  attributionHeaders,
  EMBEDDED_PI_ASSETS_HASH,
  EMBEDDED_PI_SUBCOMMAND,
  EMBEDDED_PI_VERSION,
  embeddedPiAssetFiles,
  embeddedPiAssetsStatus,
  embeddedPiChildEnv,
  embeddedPiCommand,
  embeddedPiPackageDir,
  ENV_PHANTOMBOT_PI_COMMAND,
  ensureEmbeddedPiAssets,
  isCompiledBinary,
  PHANTOMBOT_APP_TITLE,
  PHANTOMBOT_APP_URL,
  phantombotAttributionExtension,
} from "../src/lib/embeddedPi.ts";

describe("embedded pi: pin and entry", () => {
  test("the engine version is pinned EXACTLY in package.json (no range)", () => {
    const deps = pkg.dependencies as Record<string, string>;
    expect(deps["@earendil-works/pi-coding-agent"]).toBe(EMBEDDED_PI_VERSION);
    expect(EMBEDDED_PI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("src/index.ts dispatches the embedded subcommand before the CLI", async () => {
    const entry = await readFile(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
    const dispatch = entry.indexOf("process.argv[2] === EMBEDDED_PI_SUBCOMMAND");
    expect(dispatch).toBeGreaterThan(-1);
    expect(dispatch).toBeLessThan(entry.indexOf("runMain("));
    expect(EMBEDDED_PI_SUBCOMMAND).toBe("__pi");
  });

  test("isCompiledBinary: bunfs / ~BUN module urls are compiled, a file url is not", () => {
    expect(isCompiledBinary("file:///$bunfs/root/phantombot")).toBe(true);
    expect(isCompiledBinary("file:///B:/~BUN/root/phantombot.exe")).toBe(true);
    expect(isCompiledBinary("file:///B:/%7EBUN/root/phantombot.exe")).toBe(true);
    expect(isCompiledBinary("file:///home/dev/phantombot/src/lib/embeddedPi.ts")).toBe(false);
  });

  test("embeddedPiCommand: compiled re-enters the binary; from source re-runs the entry", () => {
    expect(
      embeddedPiCommand({ execPath: "/usr/local/bin/phantombot", moduleUrl: "file:///$bunfs/root/x" }),
    ).toEqual(["/usr/local/bin/phantombot", "__pi"]);
    expect(
      embeddedPiCommand({ execPath: "/usr/bin/bun", moduleUrl: "file:///src/x.ts", entry: "/src/index.ts" }),
    ).toEqual(["/usr/bin/bun", "/src/index.ts", "__pi"]);
    const fromHere = embeddedPiCommand();
    expect(fromHere[fromHere.length - 1]).toBe("__pi");
    expect(fromHere[1]).toEndWith(join("src", "index.ts"));
  });
});

describe("attribution (native mode only)", () => {
  test("reports as Phantomyard's Phantombot, linking to phantombot.bot", () => {
    expect(PHANTOMBOT_APP_TITLE).toBe("Phantomyard's Phantombot");
    expect(PHANTOMBOT_APP_URL).toBe("https://phantombot.bot");
    expect(attributionHeaders()).toEqual({
      "HTTP-Referer": "https://phantombot.bot",
      "X-OpenRouter-Title": "Phantomyard's Phantombot",
      "X-Title": "Phantomyard's Phantombot",
    });
  });

  test("the extension stamps the headers IN PLACE (pi ignores the handler's return value)", () => {
    let handler: ((e: { headers?: Record<string, string | null | undefined> }) => unknown) | undefined;
    phantombotAttributionExtension({
      on: (event, h) => {
        expect(event).toBe("before_provider_headers");
        handler = h;
      },
    });
    const headers: Record<string, string | null | undefined> = {
      Authorization: "Bearer k",
      "X-Title": "pi",
    };
    handler!({ headers });
    expect(headers).toEqual({ Authorization: "Bearer k", ...attributionHeaders() });
  });
});

describe("PI_PACKAGE_DIR assets", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "phantombot-embedded-pi-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("pi's package.json and both themes, in a version+hash stamped dir", () => {
    const files = embeddedPiAssetFiles();
    expect([...files.keys()].sort()).toEqual(["package.json", "theme/dark.json", "theme/light.json"]);
    expect(JSON.parse(files.get("package.json")!).version).toBe(EMBEDDED_PI_VERSION);
    expect(embeddedPiPackageDir("/data")).toBe(
      join("/data", "phantombot", "embedded-pi", `${EMBEDDED_PI_VERSION}-${EMBEDDED_PI_ASSETS_HASH}`),
    );
  });

  test("extract, detect drift, repair — and a no-op run writes nothing", async () => {
    expect(embeddedPiAssetsStatus(dir).drifted.sort()).toEqual([
      "package.json",
      "theme/dark.json",
      "theme/light.json",
    ]);
    expect(ensureEmbeddedPiAssets(dir).wrote.length).toBe(3);
    expect(embeddedPiAssetsStatus(dir).drifted).toEqual([]);
    expect(ensureEmbeddedPiAssets(dir).wrote).toEqual([]);

    await writeFile(join(dir, "theme", "dark.json"), "{}", "utf8");
    expect(embeddedPiAssetsStatus(dir).drifted).toEqual(["theme/dark.json"]);
    expect(ensureEmbeddedPiAssets(dir).wrote).toEqual(["theme/dark.json"]);
    expect(await readFile(join(dir, "theme", "dark.json"), "utf8")).toBe(
      embeddedPiAssetFiles().get("theme/dark.json")!,
    );
  });

  test("child env from source: delegate command set, no PI_PACKAGE_DIR (pi finds its real package)", () => {
    const env = embeddedPiChildEnv(dir);
    expect(JSON.parse(env[ENV_PHANTOMBOT_PI_COMMAND]!)).toEqual(embeddedPiCommand());
    expect(env.PI_PACKAGE_DIR).toBeUndefined();
  });
});

describe("the real engine", () => {
  test("`__pi --version` runs the embedded pi and prints its version", async () => {
    const home = await mkdtemp(join(tmpdir(), "phantombot-pi-home-"));
    try {
      const proc = Bun.spawn([...embeddedPiCommand(), "--version"], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: home, PI_OFFLINE: "1" },
      });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(out.trim()).toContain(EMBEDDED_PI_VERSION);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);
});
