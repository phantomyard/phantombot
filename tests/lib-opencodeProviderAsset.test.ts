/**
 * The embedded OpenCode provider asset must be BYTE-IDENTICAL to the source file
 * it is generated from.
 *
 * This is the check the .vsix asset did not have, and it shipped a stale release
 * because of it: the embedded artefact and its source are only ever consistent
 * with each other, so a forgotten regeneration is invisible. Here the source is
 * a text file that lives in the repo, so the test can re-derive the hash and
 * fail when someone edits the module without running the codegen.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  OPENCODE_PROVIDER_FILENAME,
  OPENCODE_PROVIDER_SHA256,
  OPENCODE_PROVIDER_SOURCE_BASE64,
} from "../src/lib/opencodeProviderAsset.generated.ts";
import { opencodeProviderSource } from "../src/connectors/acp/installOpencode.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePath = join(root, "src/connectors/acp/opencode/provider/index.mjs");

describe("opencode provider asset", () => {
  test("embedded sha256 matches the source file on disk", () => {
    const onDisk = readFileSync(sourcePath);
    const digest = createHash("sha256").update(onDisk).digest("hex");
    expect(digest).toBe(OPENCODE_PROVIDER_SHA256);
  });

  test("embedded bytes decode back to the exact source", () => {
    const embedded = Buffer.from(OPENCODE_PROVIDER_SOURCE_BASE64, "base64");
    expect(embedded.equals(readFileSync(sourcePath))).toBe(true);
  });

  test("staged filename is the module name OpenCode imports", () => {
    expect(OPENCODE_PROVIDER_FILENAME).toBe("index.mjs");
    expect(opencodeProviderSource().toString("utf8")).toContain("createPhantombot");
  });

  test("the module exports exactly one provider factory", async () => {
    // OpenCode picks the FIRST export whose name starts with `create`. A second
    // one (say a helper) would make the selection order-dependent and silently
    // break every model, so the contract is asserted here.
    const mod = (await import(sourcePath)) as Record<string, unknown>;
    const factories = Object.keys(mod).filter((key) => key.startsWith("create"));
    expect(factories).toEqual(["createPhantombot"]);
  });

  test("the module has no npm dependencies", () => {
    const source = readFileSync(sourcePath, "utf8");
    const imports = [...source.matchAll(/^import\s[^;]*from\s+"([^"]+)"/gm)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) {
      expect(specifier.startsWith("node:")).toBe(true);
    }
  });
});
