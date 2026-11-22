/** A real cached Chromium must pass the existing host probe and serve WebView.
 * CI installs the browser into a throwaway cache, never a runtime dependency. */
import { expect, test } from "bun:test";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { browserCandidates, resolveBrowserExecutable, systemHost } from "../src/browser/discovery.ts";
import { browserCall } from "../src/browser/daemon.ts";

test.skipIf(process.env.PHANTOMBOT_BROWSER_LIVE !== "1" || !process.env.PHANTOMBOT_BROWSER_CACHE_LIVE)("cached Chromium is auto-selected, launch-probed, and renders through a fresh worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-browser-cache-live-"));
  const cache = resolve(process.env.PHANTOMBOT_BROWSER_CACHE_LIVE!);
  const override = process.env.BUN_CHROME_PATH;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<h1>Cache discovery works</h1>", { headers: { "Content-Type": "text/html" } }) });
  try {
    delete process.env.BUN_CHROME_PATH;
    const host = systemHost({ ...process.env, PLAYWRIGHT_BROWSERS_PATH: cache });
    // A runner's preinstalled Chrome must not satisfy this regression.
    const isFile = host.isFile;
    host.isFile = path => path.startsWith(cache + sep) && isFile(path);
    host.which = () => null;
    const candidates = browserCandidates(host);
    expect(candidates.length).toBeGreaterThan(0);
    const selected = await resolveBrowserExecutable(root, root, { host });
    expect(selected.source).toBe("probed");
    expect(candidates.map(c => c.path)).toContain(selected.path!);
    expect(JSON.parse(await readFile(join(root, "detected.json"), "utf8")).path).toBe(selected.path);
    expect((await resolveBrowserExecutable(root, root, { host })).source).toBe("detected");
    const page = await browserCall(root, { action: "open", url: `http://127.0.0.1:${server.port}` }) as { text: string };
    expect(page.text).toContain("Cache discovery works");
    const shot = await browserCall(root, { action: "screenshot" }) as { path: string };
    expect((await readFile(shot.path)).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    if (process.platform === "linux") {
      // Reproduce a fresh download without touching the configured CI/host
      // build. A user-owned 0755 helper must fail with the real sandbox on.
      const freshCache = join(root, "fresh-cache");
      const broken = join(freshCache, "chromium-999999", "chrome-linux64");
      await cp(dirname(selected.path!), broken, { recursive: true });
      await chmod(join(broken, "chrome-sandbox"), 0o755);
      const freshHost = systemHost({ ...process.env, PLAYWRIGHT_BROWSERS_PATH: freshCache });
      freshHost.isFile = path => path.startsWith(freshCache + sep) && isFile(path);
      freshHost.which = () => null;
      const settings = join(root, "fresh-settings");
      await expect(resolveBrowserExecutable(settings, settings, { host: freshHost })).rejects.toThrow("chrome-sandbox");
      await expect(readFile(join(settings, "detected.json"))).rejects.toThrow();
      // A usable older revision must still win after the real failed probe.
      const working = join(freshCache, "chromium-1", "chrome-linux64");
      await mkdir(working, { recursive: true });
      await symlink(selected.path!, join(working, "chrome"));
      const fallback = await resolveBrowserExecutable(settings, settings, { host: freshHost });
      expect(fallback.path).toBe(join(working, "chrome"));
      expect(JSON.parse(await readFile(join(settings, "detected.json"), "utf8")).path).toBe(fallback.path);
    }
  } catch (error) {
    console.error(await readFile(join(root, "worker.log"), "utf8").catch(() => "(no browser log)"));
    throw error;
  } finally {
    await browserCall(root, { action: "stop" }).catch(() => {});
    if (override === undefined) delete process.env.BUN_CHROME_PATH;
    else process.env.BUN_CHROME_PATH = override;
    await server.stop(true);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}, 120_000);
