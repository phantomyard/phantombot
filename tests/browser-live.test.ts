/** Real rendering/IPC proof, opt-in locally; required on Linux/macOS/Windows CI. */
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserCall } from "../src/browser/daemon.ts";

test.skipIf(process.env.PHANTOMBOT_BROWSER_LIVE !== "1")("Chrome worker renders, interacts, captures PNG and persists isolated cookies", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-browser-live-"));
  const other = await mkdtemp(join(tmpdir(), "pb-browser-other-"));
  const agents: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    agents.push(req.headers.get("user-agent") ?? "");
    return new Response(`<html><head><title>Phantom fixture</title></head><body><h1>Rendered fixture</h1><p hidden>HIDDEN SECRET</p><input id="entry"><button id="button" onclick="document.querySelector('#result').textContent=document.querySelector('#entry').value">Apply</button><p id="result">waiting</p><a href="/next">Next page</a><script>document.body.dataset.ready='yes';document.cookie='phantom=present; Max-Age=3600; Path=/'</script></body></html>`, { headers: { "Content-Type": "text/html" } });
  } });
  try {
    const page = await browserCall(root, { action: "open", url: `http://127.0.0.1:${server.port}` }) as { text: string; elements: { selector: string; tag: string }[] };
    expect(page.text).toContain("Rendered fixture"); expect(page.text).not.toContain("HIDDEN SECRET");
    expect(agents[0]).toContain("Chrome/"); expect(agents[0]).not.toContain("HeadlessChrome");
    await browserCall(root, { action: "click", selector: page.elements.find(e => e.tag === "input")!.selector });
    await browserCall(root, { action: "type", text: "Phantom typed this" });
    const clicked = await browserCall(root, { action: "click", selector: "#button" }) as { text: string };
    expect(clicked.text).toContain("Phantom typed this");
    await browserCall(root, { action: "resize", width: 900, height: 600 });
    const shot = await browserCall(root, { action: "screenshot" }) as { path: string };
    const bytes = await readFile(shot.path);
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(bytes.readUInt32BE(16)).toBe(900); expect(bytes.readUInt32BE(20)).toBe(600);
    // Server-side observation proves persistence and profile isolation without
    // exposing a general evaluate() or credential-reading tool to the model.
    await browserCall(root, { action: "stop" });
    // Let the old process release its profile and lock before another start.
    await Bun.sleep(200);
    const cookies: string[] = [];
    const cookieServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { cookies.push(req.headers.get("cookie") ?? ""); return new Response("cookies checked"); } });
    try {
      await browserCall(root, { action: "open", url: `http://127.0.0.1:${cookieServer.port}` });
      expect(cookies[0]).toContain("phantom=present");
      cookies.length = 0;
      await browserCall(other, { action: "open", url: `http://127.0.0.1:${cookieServer.port}` });
      expect(cookies[0]).not.toContain("phantom=present");
    } finally { await cookieServer.stop(true); }
  } catch (error) {
    // The test owns both throwaway profiles; report Chrome launch failures
    // before deleting them, so platform CI failures are actually diagnosable.
    for (const path of [root, other]) console.error(await readFile(join(path, "worker.log"), "utf8").catch(() => "(no browser log)"));
    throw error;
  } finally {
    await Promise.allSettled([browserCall(root, { action: "stop" }), browserCall(other, { action: "stop" })]);
    await Bun.sleep(200);
    await server.stop(true);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await rm(other, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}, 60_000);
