import { copyFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";

/** Called once on a fresh runtime-owned directory, before any model tool. */
export function prepareSandboxTools(workspace: string): void {
  const directory = join(workspace, ".tools");
  mkdirSync(directory, { mode: 0o700 });
  for (const name of ["bun", "node"]) {
    const source =
      Bun.which(name) ??
      (basename(process.execPath).replace(/\.exe$/i, "") === name
        ? process.execPath
        : undefined);
    if (source)
      copyFileSync(
        source,
        join(directory, name + (process.platform === "win32" ? ".exe" : "")),
      );
  }
}
