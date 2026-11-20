/** An untrusted turn's browser lives on the host, behind the existing broker.
 * Its profile/endpoint are NEVER inside the model-writable workspace: a symlink
 * there must not redirect a privileged browser write into an arbitrary host path. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { browserCall } from "./daemon.ts";
import { validateRequest } from "./session.ts";

export class TurnBrowser {
  private root?: Promise<string>;
  private closed = false;
  private screenshots: string[] = [];
  constructor(private personaDir: string, private workspace: string, private signal: AbortSignal, private conversation?: string) {}

  async execute(raw: unknown): Promise<unknown> {
    this.signal.throwIfAborted();
    if (this.closed) throw new Error("Browser session is closed");
    const request = validateRequest(raw);
    if (!request.session && this.conversation) request.session = new Bun.CryptoHasher("sha256").update(this.conversation).digest("hex");
    if (!this.root && ["close", "stop"].includes(request.action)) return { result: { running: false } };
    this.root ??= (async () => {
      const parent = join(this.personaDir, "browser-turns");
      await mkdir(parent, { recursive: true, mode: 0o700 });
      return mkdtemp(join(parent, "turn-"));
    })();
    const root = await this.root;
    const result = await browserCall(root, request, this.signal);
    this.signal.throwIfAborted();
    if (request.action !== "screenshot") return { result };
    const shot = result as { path: string; url: string; title: string };
    if (dirname(resolve(shot.path)) !== resolve(root, "screenshots")) throw new Error("Invalid browser screenshot path");
    const bytes = await readFile(shot.path);
    this.signal.throwIfAborted();
    if (bytes.length > 10 * 1024 * 1024) throw new Error("Screenshot exceeds 10 MB; reduce the viewport size");
    // The only host write into untrusted scratch is a new random image at its
    // root. Exclusive creation refuses existing files AND symlinks; no model-
    // writable child directory participates in this path.
    const path = join(this.workspace, `browser-${crypto.randomUUID()}.png`);
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    this.screenshots.push(path);
    for (const old of this.screenshots.splice(0, Math.max(0, this.screenshots.length - 32))) await rm(old, { force: true }).catch(() => {});
    return { result: { path, url: shot.url, title: shot.title, mimeType: "image/png" }, image: { data: bytes.toString("base64"), mimeType: "image/png" } };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.root) return;
    const root = await this.root;
    await browserCall(root, { action: "stop" }).catch(() => {});
    // /shutdown acknowledges after Chrome cleanup; give the worker itself time
    // to release its lock before removing this host-only disposable directory.
    await Bun.sleep(100);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
