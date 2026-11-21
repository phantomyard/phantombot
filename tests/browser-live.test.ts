/** Real rendering/IPC proof, opt-in locally; required on Linux/macOS/Windows CI. */
import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserCall } from "../src/browser/daemon.ts";

test.skipIf(process.env.PHANTOMBOT_BROWSER_LIVE !== "1")("Chrome worker renders, interacts, captures PNG and persists isolated cookies", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-browser-live-"));
  const other = await mkdtemp(join(tmpdir(), "pb-browser-other-"));
  const agents: string[] = [];
  const identities = new Map<string, { ua: string; hints: string | null }>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    agents.push(req.headers.get("user-agent") ?? "");
    const path = new URL(req.url).pathname;
    if (path.startsWith("/identity/")) {
      identities.set(path, { ua: req.headers.get("user-agent") ?? "", hints: req.headers.get("sec-ch-ua") });
      return new Response(`<body><script>document.body.innerText=JSON.stringify({ua:navigator.userAgent,brands:navigator.userAgentData?.brands ?? []})</script>`, { headers: { "Content-Type": "text/html" } });
    }
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
    // Observe headers AND page JS; repeated opens must retain/reset identity,
    // custom metadata must not leak actual Chrome hints, and tabs stay isolated.
    const identity = async (path: string, extra = {}) => {
      const result = await browserCall(root, { action: "open", url: `http://127.0.0.1:${server.port}/identity/${path}`, ...extra }) as { text: string };
      const js = JSON.parse(result.text) as { ua: string; brands: unknown[] };
      const headers = identities.get(`/identity/${path}`)!;
      expect(js.ua).toBe(headers.ua);
      return { js, headers };
    };
    const baseline = await identity("default");
    expect(baseline.headers.ua).toContain("Chrome/");
    const custom = await identity("custom", { userAgent: "PhantomCustom/1.0" });
    expect(custom.headers).toEqual({ ua: "PhantomCustom/1.0", hints: null });
    expect(custom.js.brands).toEqual([]);
    expect((await identity("retained")).headers.ua).toBe("PhantomCustom/1.0");
    expect((await identity("other", { session: "other" })).headers.ua).toBe(baseline.headers.ua);
    expect((await identity("reset", { userAgent: null }))).toEqual(baseline);
    await identity("before-close", { userAgent: "Temporary/1" });
    await browserCall(root, { action: "close" });
    expect((await identity("reopened")).headers.ua).toBe(baseline.headers.ua);
    // Server-side observation proves persistence and profile isolation without
    // exposing a general evaluate() or credential-reading tool to the model.
    await browserCall(root, { action: "stop" });
    // Let the old process release its profile and lock before another start.
    await Bun.sleep(200);
    const cookies = { persisted: [] as string[], isolated: [] as string[] };
    const cookieServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
      const path = new URL(req.url).pathname;
      // Chrome may request the first tab's favicon after the second profile
      // starts. Attribute evidence by the requested route, never arrival order.
      if (path === "/persisted") cookies.persisted.push(req.headers.get("cookie") ?? "");
      if (path === "/isolated") cookies.isolated.push(req.headers.get("cookie") ?? "");
      return new Response("cookies checked");
    } });
    try {
      await browserCall(root, { action: "open", url: `http://127.0.0.1:${cookieServer.port}/persisted` });
      expect(cookies.persisted).toEqual(["phantom=present"]);
      await browserCall(other, { action: "open", url: `http://127.0.0.1:${cookieServer.port}/isolated` });
      expect(cookies.isolated).toEqual([""]);
    } finally { await cookieServer.stop(true); }
  } catch (error) {
    console.error(`Fixture received ${agents.length} HTTP requests`);
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

// Issue #810: launch-tested discovery and post-action page state, on real Chrome.
test.skipIf(process.env.PHANTOMBOT_BROWSER_LIVE !== "1")("probe vouches only for a browser that starts; cascade picks one without BUN_CHROME_PATH", async () => {
  const { browserCandidates, probeBrowser, resolveBrowserExecutable, systemHost } = await import("../src/browser/discovery.ts");
  const root = await mkdtemp(join(tmpdir(), "pb-browser-probe-"));
  try {
    const env = { ...process.env }; delete env.BUN_CHROME_PATH;
    const host = systemHost(env);
    const known = process.env.BUN_CHROME_PATH ?? browserCandidates(host)[0]?.path;
    if (known) expect(await probeBrowser(known, root)).toEqual({ ok: true });
    expect((await probeBrowser(join(root, "no-such-chrome"), root)).ok).toBe(false);
    const resolved = await resolveBrowserExecutable(root, root, { host });
    if (browserCandidates(host).length) expect(resolved).toMatchObject({ source: "probed" });
    else expect(resolved).toEqual({ source: "bun" });
    // Probe profiles never outlive the probe.
    expect((await readdir(root)).filter(n => n.startsWith("probe-"))).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}, 90_000);

test.skipIf(process.env.PHANTOMBOT_BROWSER_LIVE !== "1")("press/click return the navigated page; failed clicks keep the tab; unstable boxes still click", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-browser-nav-"));
  let covered = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url);
    const html = (body: string) => new Response(`<html><head><title>${url.pathname}</title></head><body>${body}</body></html>`, { headers: { "Content-Type": "text/html" } });
    if (url.pathname === "/results") { await Bun.sleep(700); return html(`<p>Results for ${url.searchParams.get("q")}</p><a id="next" href="/slow">Slow link</a>`); }
    if (url.pathname === "/slow") { await Bun.sleep(700); return html("<p>Slow page arrived</p>"); }
    if (url.pathname === "/covered") { covered++; return html("<p>covered</p>"); }
    // The input's box changes every animation frame (never "stable"), like an
    // animated header; the button sits under a full-page overlay.
    return html(`<form action="/results"><input id="q" name="q"></form><p id="mirror"></p>
      <div style="margin-top:400px"><button id="hidden" onclick="fetch('/covered')">Covered</button></div><div style="height:1200px"></div>
      <div style="position:fixed;left:0;top:200px;right:0;bottom:0;background:#fff"></div>
      <script>const q=document.querySelector('#q');let f=0;(function wiggle(){q.style.marginLeft=(f++%2)+'px';requestAnimationFrame(wiggle)})();
      q.addEventListener('input',()=>{document.querySelector('#mirror').textContent='typed:'+q.value});</script>`);
  } });
  try {
    await browserCall(root, { action: "open", url: `http://127.0.0.1:${server.port}/` });
    await browserCall(root, { action: "click", selector: "#q" });
    expect((await browserCall(root, { action: "type", text: "phantom" }) as { text: string }).text).toContain("typed:phantom");
    const searched = await browserCall(root, { action: "press", key: "Enter" }) as { url: string; text: string };
    expect(searched.url).toContain("/results?q=phantom");
    expect(searched.text).toContain("Results for phantom");
    const followed = await browserCall(root, { action: "click", selector: "#next" }) as { text: string };
    expect(followed.text).toContain("Slow page arrived");
    const shot = await browserCall(root, { action: "screenshot" }) as { title: string };
    expect(shot.title).toBe("/slow");
    await expect(browserCall(root, { action: "click", selector: "#does-not-exist" })).rejects.toThrow("(the tab is still open)");
    expect((await browserCall(root, { action: "read" }) as { text: string }).text).toContain("Slow page arrived");
    await browserCall(root, { action: "open", url: `http://127.0.0.1:${server.port}/` });
    await expect(browserCall(root, { action: "click", selector: "#hidden" })).rejects.toThrow("still open");
    expect(covered).toBe(0);
  } catch (error) {
    console.error(await readFile(join(root, "worker.log"), "utf8").catch(() => "(no browser log)"));
    throw error;
  } finally {
    await browserCall(root, { action: "stop" }).catch(() => {});
    await Bun.sleep(200);
    await server.stop(true);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}, 120_000);
