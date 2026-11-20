/** Bun's experimental WebView is feature-detected: older runtimes can still run the CLI. */
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromeArgv } from "./discovery.ts";

export interface BrowserView {
  url: string;
  title: string;
  navigate(url: string): Promise<unknown>;
  evaluate(script: string): Promise<unknown>;
  cdp(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  screenshot(options: { encoding: "buffer" }): Promise<Buffer>;
  click(selector: string, options: { timeout: number }): Promise<unknown>;
  click(x: number, y: number): Promise<unknown>;
  type(text: string): Promise<unknown>;
  press(key: string): Promise<unknown>;
  scroll(dx: number, dy: number): Promise<unknown>;
  scrollTo(selector: string, options: { timeout: number }): Promise<unknown>;
  resize(width: number, height: number): Promise<unknown>;
  close(): void;
  addEventListener?(type: string, listener: (event: Event) => void): void;
  removeEventListener?(type: string, listener: (event: Event) => void): void;
}

export interface WebViewRuntime {
  new(options: {
    backend: { type: "chrome"; url: false; stderr: "inherit"; argv: string[] };
    dataStore: { directory: string };
    width: number;
    height: number;
  }): BrowserView;
  closeAll(): void;
}

export function webViewRuntime(): WebViewRuntime {
  const runtime = (Bun as unknown as { WebView?: WebViewRuntime }).WebView;
  if (!runtime) throw new Error("This Bun runtime has no Bun.WebView. Update phantombot (or Bun when running from source).");
  return runtime;
}

/** Error prefix for a browser that never launched; daemon.ts drops the cached
 * executable on it so the next open runs discovery again. */
export const CHROME_START_FAILED = "Chrome failed to start";
/** After a click/key press: how long a navigation has to begin, then finish. */
export const NAVIGATION_GRACE_MS = 300;
export const NAVIGATION_WAIT_MS = 8_000;
const SELECTOR_WAIT_MS = 10_000;

export const BROWSER_ACTIONS = ["open", "read", "screenshot", "click", "type", "press", "scroll", "resize", "close", "stop"] as const;
export type BrowserAction = typeof BROWSER_ACTIONS[number];
export interface BrowserRequest {
  action: BrowserAction;
  session?: string;
  url?: string;
  /** Omit to retain this tab's identity; null restores installed Chrome. */
  userAgent?: string | null;
  selector?: string;
  text?: string;
  key?: string;
  dx?: number;
  dy?: number;
  width?: number;
  height?: number;
}

function requiredString(value: unknown, name: string, max = 16_000): string {
  if (typeof value !== "string" || !value || value.length > max) throw new Error(`${name} must be a nonempty string of at most ${max} characters`);
  return value;
}

export function validateRequest(value: unknown): BrowserRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a browser request object");
  const r = value as BrowserRequest;
  if (!BROWSER_ACTIONS.includes(r.action)) throw new Error("Unknown browser action");
  if (r.session !== undefined && !/^[a-zA-Z0-9_-]{1,80}$/.test(requiredString(r.session, "session", 80))) throw new Error("Invalid browser session name");
  if (r.userAgent !== undefined) {
    if (r.action !== "open") throw new Error("userAgent is only supported with open");
    if (r.userAgent !== null && (typeof r.userAgent !== "string" || !/^[\x20-\x7e]{1,512}$/.test(r.userAgent) || !r.userAgent.trim())) throw new Error("userAgent must be printable ASCII (1..512 characters), or null to reset");
  }
  switch (r.action) {
    case "open": {
      const url = new URL(requiredString(r.url, "url"));
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http:// and https:// URLs are supported");
      if (url.username || url.password) throw new Error("URL credentials are not supported");
      break;
    }
    case "click": requiredString(r.selector, "selector", 2000); break;
    case "type": requiredString(r.text, "text"); break;
    case "press": requiredString(r.key, "key", 32); break;
    case "scroll":
      for (const n of [r.dx ?? 0, r.dy]) if (typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 100_000) throw new Error("scroll needs finite dx/dy within 100000 pixels");
      break;
    case "resize":
      for (const n of [r.width, r.height]) if (!Number.isInteger(n) || n! < 1 || n! > 4096) throw new Error("width/height must be integers from 1 to 4096");
      break;
  }
  return r;
}

// Text and selectors are DATA returned by a site, never instructions. Return a
// bounded rendered snapshot rather than the source (which includes hidden text).
export const SNAPSHOT_SCRIPT = `(() => {
  const visible = e => { const r=e.getBoundingClientRect(); const s=getComputedStyle(e); return r.width>0 && r.height>0 && s.visibility!=='hidden' && s.display!=='none'; };
  const text = document.body?.innerText || '';
  const candidates = document.querySelectorAll('a[href],button,input:not([type=hidden]),textarea,select,[role=button],[contenteditable=true]');
  const elements=[];
  for (let i=0; i<candidates.length && elements.length<100; i++) {
    const e=candidates[i]; if (!visible(e)) continue;
    // nth-of-type paths remain usable until the next DOM change; never stamp
    // attributes a hostile page can pre-populate and redirect to another node.
    const parts=[]; let n=e;
    while(n && n.nodeType===1) { let index=1; for(let p=n.previousElementSibling;p;p=p.previousElementSibling) if(p.tagName===n.tagName) index++;
      parts.unshift(n.tagName.toLowerCase()+':nth-of-type('+index+')'); n=n.parentElement; }
    const r=e.getBoundingClientRect();
    elements.push({selector:parts.join(' > ').slice(0,2000),tag:e.tagName.toLowerCase(),label:(e.getAttribute('aria-label')||e.innerText||e.getAttribute('placeholder')||e.getAttribute('name')||'').slice(0,160),type:e.getAttribute('type'),href:e.href?e.href.slice(0,2000):undefined,inViewport:r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth});
  }
  return {url:location.href,title:document.title,text:text.slice(0,24000),truncated:text.length>24000,elements};
})()`;

/** Center of `selector` when it is visible in the viewport and the topmost hit
 * there is the element itself, a descendant, or its own <label>. Used only
 * after Bun's stricter actionability wait gave up: that check needs a box
 * stable across animation frames, which never happens when headless Chrome
 * throttles rAF or a header animates (issue #810). Never clicks an overlay. */
export function hitPointScript(selector: string): string {
  return `((selector) => {
  const e = document.querySelector(selector); if (!e) return null;
  const r = e.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return null;
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
  const hit = document.elementFromPoint(x, y); if (!hit) return null;
  const label = hit.closest('label');
  return e === hit || e.contains(hit) || (label && label.control === e) ? { x, y } : null;
})(${JSON.stringify(selector)})`;
}

const PAGE_STATE_SCRIPT = "({ url: location.href, title: document.title })";

/** One instance per dedicated process: Bun's Chrome profile is process-wide. */
export class BrowserSessions {
  private views = new Map<string, BrowserView>();
  private identities = new WeakMap<BrowserView, { userAgent: string; metadata: unknown; custom?: string }>();
  private pageEvents = new WeakSet<BrowserView>();
  /** Chrome is gone for good: Bun will not relaunch it in this process. */
  chromeGone = false;
  constructor(private root: string, private runtime: WebViewRuntime = webViewRuntime(), private timeoutMs = 30_000) {}

  async execute(raw: unknown): Promise<unknown> {
    const r = validateRequest(raw);
    const name = r.session ?? "default";
    if (r.action === "stop") { await this.shutdown(); return { stopped: true }; }
    if (r.action === "close") {
      if (this.views.has(name) && this.views.size === 1) {
        await this.shutdown();
        return { closed: name };
      }
      this.views.get(name)?.close(); this.views.delete(name);
      return { closed: name };
    }
    let view = this.views.get(name);
    if (!view) {
      if (r.action !== "open") throw new Error(`Session '${name}' is not open; use browser open first`);
      if (this.views.size >= 8) throw new Error("Eight browser tabs are already open; close a session first");
      await mkdir(join(this.root, "profile"), { recursive: true, mode: 0o700 });
      view = new this.runtime({ backend: { type: "chrome", url: false, stderr: "inherit", argv: chromeArgv() }, dataStore: { directory: join(this.root, "profile") }, width: 1280, height: 800 });
      this.views.set(name, view);
    }
    const current = view;
    let stage: string = r.action;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      return await Promise.race([
        this.perform(current, r, value => { stage = value; }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => {
          timedOut = true;
          current.close(); this.views.delete(name);
          reject(new Error(`Browser operation timed out during ${stage}; the affected session was closed`));
        }, this.timeoutMs); }),
      ]);
    } catch (e) {
      clearTimeout(timer);
      // A missing selector or a failed site navigation leaves a working tab:
      // keep its page, cookies and login (issue #810). Only a tab that no
      // longer answers is closed.
      const startFailed = (e as Error).message.startsWith(CHROME_START_FAILED);
      if (!timedOut && !startFailed && this.views.get(name) === current && await this.responsive(current)) {
        throw new Error(`${(e as Error).message} (the tab is still open)`);
      }
      // A crashed Chrome leaves every tab unusable. Start fresh on the next open.
      current.close(); this.views.delete(name);
      if (this.views.size === 0) { this.runtime.closeAll(); this.chromeGone = true; }
      throw e;
    } finally { clearTimeout(timer); }
  }

  private async perform(view: BrowserView, r: BrowserRequest, stage: (value: string) => void): Promise<unknown> {
    switch (r.action) {
      case "open": {
        // Establish the CDP session on a blank page BEFORE any site request.
        stage("Chrome startup");
        try { await view.navigate("about:blank"); }
        catch (error) { throw new Error(`${CHROME_START_FAILED}: ${(error as Error).message}. See 'phantombot browser list' and choose another with 'phantombot browser use <browser>'.`); }
        // A host-side browser must not let a page save arbitrary files into
        // the owner's Downloads directory. This tool exposes text/images only.
        stage("download policy");
        await view.cdp("Page.setDownloadBehavior", { behavior: "deny" });
        stage("user-agent detection");
        let identity = this.identities.get(view);
        if (!identity) {
          const ua = await view.evaluate("navigator.userAgent");
          const metadata = await view.evaluate("navigator.userAgentData ? navigator.userAgentData.getHighEntropyValues(['architecture','bitness','model','platformVersion','fullVersionList','wow64']) : undefined");
          identity = { userAgent: String(ua).replace(/HeadlessChrome/g, "Chrome"), metadata };
          this.identities.set(view, identity);
        }
        if (r.userAgent !== undefined) identity.custom = r.userAgent ?? undefined;
        stage("user-agent override");
        await view.cdp("Emulation.setUserAgentOverride", {
          userAgent: identity.custom ?? identity.userAgent,
          // Arbitrary UA strings cannot truthfully inherit Chrome's client hints.
          // CDP suppresses UA hints when metadata is omitted; reset restores them.
          ...(!identity.custom && identity.metadata ? { userAgentMetadata: identity.metadata } : {}),
        });
        stage("site navigation");
        await view.navigate(r.url!);
        break;
      }
      case "click":
        await view.scrollTo(r.selector!, { timeout: Math.min(SELECTOR_WAIT_MS, this.timeoutMs) });
        stage("click");
        await this.settled(view, () => this.click(view, r.selector!), stage); break;
      case "type": await view.type(r.text!); break;
      case "press": await this.settled(view, () => view.press(r.key!), stage); break;
      case "scroll": await view.scroll(r.dx ?? 0, r.dy!); break;
      case "resize": await view.resize(r.width!, r.height!); break;
      case "screenshot": {
        const directory = join(this.root, "screenshots");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        // Keep a bounded history without ever deleting caller-owned paths.
        const previous = (await readdir(directory)).filter(n => /^\d+-[a-f0-9-]{36}\.png$/.test(n)).sort();
        for (const name of previous.slice(0, Math.max(0, previous.length - 31))) await rm(join(directory, name));
        const path = join(directory, `${Date.now()}-${crypto.randomUUID()}.png`);
        await Bun.write(path, await view.screenshot({ encoding: "buffer" }), { mode: 0o600 });
        // view.url/title update only when Bun sees a navigation complete;
        // read the live document so metadata matches the PNG (issue #810).
        const page = await view.evaluate(PAGE_STATE_SCRIPT).catch(() => undefined) as { url?: unknown; title?: unknown } | undefined;
        return { url: typeof page?.url === "string" ? page.url : view.url, title: typeof page?.title === "string" ? page.title : view.title, path, mimeType: "image/png" };
      }
    }
    stage("rendered snapshot");
    return view.evaluate(SNAPSHOT_SCRIPT);
  }

  private async click(view: BrowserView, selector: string): Promise<void> {
    try { await view.click(selector, { timeout: Math.min(SELECTOR_WAIT_MS, this.timeoutMs) }); }
    catch (error) {
      if (!/actionable/i.test((error as Error).message)) throw error;
      const point = await view.evaluate(hitPointScript(selector)).catch(() => null) as { x?: unknown; y?: unknown } | null;
      if (typeof point?.x !== "number" || typeof point.y !== "number") throw error;
      await view.click(point.x, point.y);
    }
  }

  /** Run a click/key press, then wait for any main-frame navigation it started
   * to finish, so the returned snapshot is the NEW page (issue #810). */
  private async settled(view: BrowserView, action: () => Promise<unknown>, stage: (value: string) => void): Promise<void> {
    const add = view.addEventListener?.bind(view), remove = view.removeEventListener?.bind(view);
    let frame: string | undefined;
    if (add && remove) {
      if (!this.pageEvents.has(view)) { await view.cdp("Page.enable"); this.pageEvents.add(view); }
      const tree = await view.cdp("Page.getFrameTree") as { frameTree?: { frame?: { id?: unknown } } };
      if (typeof tree.frameTree?.frame?.id === "string") frame = tree.frameTree.frame.id;
    }
    if (!frame || !add || !remove) { await action(); return; }
    let navigating = false;
    let finished!: () => void;
    const stopped = new Promise<void>(resolve => { finished = resolve; });
    const main = (event: Event) => (event as MessageEvent<{ frameId?: string }>).data?.frameId === frame;
    const start = (event: Event) => { if (main(event)) navigating = true; };
    const stop = (event: Event) => { if (main(event) && navigating) finished(); };
    add("Page.frameRequestedNavigation", start);
    add("Page.frameStartedLoading", start);
    add("Page.frameStoppedLoading", stop);
    try {
      await action();
      stage("navigation");
      const grace = Date.now() + NAVIGATION_GRACE_MS;
      while (!navigating && Date.now() < grace) await Bun.sleep(25);
      if (!navigating) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      // A navigation slower than this still returns a snapshot (of whatever
      // has rendered); `read` refreshes it.
      await Promise.race([stopped, new Promise<void>(resolve => { timer = setTimeout(resolve, NAVIGATION_WAIT_MS); })]);
      clearTimeout(timer);
    } finally {
      remove("Page.frameRequestedNavigation", start);
      remove("Page.frameStartedLoading", start);
      remove("Page.frameStoppedLoading", stop);
    }
  }

  private async responsive(view: BrowserView): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        view.evaluate("1").then(() => true, () => false),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 2000); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  closeAll(): void {
    for (const view of this.views.values()) view.close();
    this.views.clear();
    this.runtime.closeAll();
  }

  async shutdown(): Promise<void> {
    const view = this.views.values().next().value;
    if (view) {
      // closeAll() SIGKILLs Chrome: persistent cookies may never reach disk.
      // Browser.close asks Chrome to flush the profile and terminate normally.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            await view.cdp("Browser.close");
            // Tab sessions can close BEFORE Chrome finishes flushing its profile.
            // Bun exposes no browser-process exit promise; give graceful exit a
            // bounded drain window before closeAll's force-kill backstop.
            await Bun.sleep(2000);
          })(),
          new Promise<void>(resolve => { timer = setTimeout(resolve, 3000); }),
        ]);
      } catch { /* Chrome closed its pipe (or was already gone). */ }
      finally { clearTimeout(timer); }
    }
    this.closeAll();
  }
}
