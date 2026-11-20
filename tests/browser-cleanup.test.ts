import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reapTurnBrowsers } from "../src/browser/broker.ts";

test("browser cleanup removes abandoned profiles but preserves recent and live turns", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-browser-cleanup-"));
  const parent = join(root, "browser-turns");
  const old = new Date(Date.now() - 2 * 60 * 60_000);
  try {
    await mkdir(parent);
    for (const name of ["turn-stale", "turn-crashed", "turn-recent", "turn-live", "unrelated"]) {
      const path = join(parent, name);
      await mkdir(path);
      await writeFile(join(path, "profile-data"), "fixture");
      if (name === "turn-crashed") await writeFile(join(path, "owner.pid"), "2147483647");
      if (name === "turn-live") await writeFile(join(path, "owner.pid"), String(process.pid));
      if (name !== "turn-recent") await utimes(path, old, old);
    }
    await reapTurnBrowsers(parent);
    expect((await readdir(parent)).sort()).toEqual(["turn-live", "turn-recent", "unrelated"]);
    // Idempotent; a second concurrent runtime may already have reaped a path.
    await Promise.all([reapTurnBrowsers(parent), reapTurnBrowsers(parent)]);
    expect(await readFile(join(parent, "turn-live", "profile-data"), "utf8")).toBe("fixture");
    if (process.platform !== "win32") {
      await symlink(join(parent, "unrelated"), join(parent, "turn-link"));
      await reapTurnBrowsers(parent);
      expect(await readFile(join(parent, "turn-link", "profile-data"), "utf8")).toBe("fixture");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
