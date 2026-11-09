/**
 * The committed public declarations (types/engine/) must match src/engine/.
 * An application installed from a git tag gets exactly those files and no
 * build step, so a stale copy would silently misdescribe the API it runs.
 */

import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
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

test("types/engine/ compiles on its own (skipLibCheck: false, as a consumer sees it)", () => {
  // The check above only compares files; this compiles them. A type that
  // `stripInternal` drops but a public signature still names fails here.
  const repo = resolve(import.meta.dir, "..");
  const name = `.tsconfig-engine-types-${process.pid}.json`;
  const path = resolve(repo, name);
  writeFileSync(path, JSON.stringify({
    extends: "./tsconfig.json",
    compilerOptions: { noEmit: true, skipLibCheck: false },
    include: ["types/engine/**/*"],
  }));
  try {
    const r = Bun.spawnSync(
      [process.execPath, "x", "tsc", "-p", name],
      { cwd: repo, stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_BE_BUN: "1" } },
    );
    expect({ exitCode: r.exitCode, output: r.stdout.toString() + r.stderr.toString() }).toEqual({ exitCode: 0, output: "" });
  } finally {
    rmSync(path, { force: true });
  }
}, 120_000);
