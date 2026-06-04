import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandSystemdPath, whichBinary, checkConfiguredHarnesses } from "../src/lib/harnessAvailability.ts";
import type { Config } from "../src/config.ts";

describe("expandSystemdPath", () => {
  test("expands %h to home directory", () => {
    const home = "/home/test";
    const path = "%h/.local/bin:/usr/bin";
    expect(expandSystemdPath(path, home)).toBe("/home/test/.local/bin:/usr/bin");
  });

  test("expands multiple occurrences of %h", () => {
    const home = "/home/test";
    const path = "%h/bin:%h/.local/bin";
    expect(expandSystemdPath(path, home)).toBe("/home/test/bin:/home/test/.local/bin");
  });
});

describe("whichBinary", () => {
  test("resolves absolute paths", async () => {
    // /bin/sh should exist on most linux systems
    expect(await whichBinary("/bin/sh")).toBe("/bin/sh");
  });

  test("returns undefined for missing absolute paths", async () => {
    expect(await whichBinary("/tmp/definitely-not-there-12345")).toBeUndefined();
  });

  test("resolves bare names from pathEnv", async () => {
    const pathEnv = "/bin:/usr/bin";
    expect(await whichBinary("sh", pathEnv)).toBe("/bin/sh");
  });
});

describe("checkConfiguredHarnesses", () => {
  const config = {
    harnesses: {
      chain: ["claude", "pi"],
      claude: { bin: "sh" },
      pi: { bin: "definitely-missing-pi" },
      gemini: { bin: "gemini" },
    },
  } as unknown as Config;

  test("resolves available and missing harnesses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phantombot-harness-"));
    const sh = join(dir, "sh");
    await writeFile(sh, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(sh, 0o755);

    const pathEnv = dir;
    const results = await checkConfiguredHarnesses(config, pathEnv);

    const missingPi = results.find((result) => result.id === "pi");

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ id: "claude", bin: "sh", resolved: sh });
    expect(missingPi).toMatchObject({ id: "pi", bin: "definitely-missing-pi" });
    expect(missingPi?.resolved).toBeUndefined();
  });

  test("falls back to discovery when a cached absolute harness path is stale", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phantombot-harness-"));
    const pi = join(dir, "pi");
    await writeFile(pi, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(pi, 0o755);

    const staleConfig = {
      harnesses: {
        chain: ["pi"],
        claude: { bin: "claude" },
        pi: { bin: join(dir, "old", "pi") },
        gemini: { bin: "gemini" },
      },
    } as unknown as Config;

    const results = await checkConfiguredHarnesses(staleConfig, dir);

    expect(results).toEqual([
      {
        id: "pi",
        bin: join(dir, "old", "pi"),
        resolved: pi,
        source: "path",
      },
    ]);
  });
});
