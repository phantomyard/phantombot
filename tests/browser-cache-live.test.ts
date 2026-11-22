/** A real cached Chromium must pass the existing host probe and serve WebView.
 * CI installs the browser into a throwaway cache, never a runtime dependency. */
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
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
