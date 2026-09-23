/**
 * The committed public declarations (types/engine/) must match src/engine/.
 * An application installed from a git tag gets exactly those files and no
 * build step, so a stale copy would silently misdescribe the API it runs.
 */

import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("types/engine/ is regenerated from src/engine/ (bun run build:engine-types)", () => {
  const repo = resolve(import.meta.dir, "..");
  const r = Bun.spawnSync(
    [process.execPath, "scripts/buildEngineTypes.ts", "--check"],
    { cwd: repo, stdout: "pipe", stderr: "pipe" },
  );
  const output = r.stdout.toString() + r.stderr.toString();
  expect({ exitCode: r.exitCode, output }).toEqual({
    exitCode: 0,
    output: expect.stringContaining("up to date"),
  });
}, 60_000);
