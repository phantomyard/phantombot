import { expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSecuritySession } from "../src/security/session.ts";
import { invokeSession, sessionToolResult } from "../src/security/extension.ts";

test.skipIf(process.env.PHANTOMBOT_BROWSER_LIVE !== "1")("sandboxed compiled CLI shares its host browser across calls and broker returns a visible image", async () => {
  const binary = process.env.PHANTOMBOT_BROWSER_TEST_BINARY;
  if (!binary) throw new Error("PHANTOMBOT_BROWSER_TEST_BINARY must name this checkout's compiled binary");
  const root = await mkdtemp(join(tmpdir(), "pb-browser-broker-"));
  const isolatedCookies: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    if (new URL(req.url).pathname === "/isolation-check") isolatedCookies.push(req.headers.get("cookie") ?? "");
    return new Response('<html><title>Broker fixture</title><body><h1>Sandbox browser</h1><input id="entry"><button id="apply" onclick="document.getElementById(\'result\').textContent=document.getElementById(\'entry\').value">Apply</button><p id="result">ready</p><script>document.cookie="turn=private; Max-Age=3600; Path=/"</script></body></html>', { headers: { "content-type": "text/html" } });
  } });
  const audits: string[] = [];
  const session = await createSecuritySession({ personaDir: root, persona: "fixture", turnId: "one", conversation: "fixture:one", policy: { version: 1, enabled: true, grants: [] }, audit: e => { audits.push(e.operation); } });
  let privateRoot: string | undefined;
  try {
    const workspace = session.descriptor.workspace;
    const executable = join(workspace, process.platform === "win32" ? "browser-cli.exe" : "browser-cli");
    await copyFile(resolve(binary), executable);
    // The host must never store its browser profile under a directory the
    // sandbox can replace with a link to somewhere else on the host.
    const sentinel = join(root, "host-sentinel");
    await writeFile(sentinel, "unchanged");
    if (process.platform !== "win32") await symlink(root, join(workspace, "browser"));
    const command = async (suffix: string) => {
      const response = await invokeSession(session.descriptor, { kind: "sandbox", command: `"${executable}" browser ${suffix}` });
      expect(response.ok, response.text).toBe(true);
      const result = JSON.parse(response.text) as { exitCode: number; output: string };
      expect(result.exitCode, result.output).toBe(0);
      return result.output;
    };
    expect(await command(`open http://127.0.0.1:${server.port}`)).toContain("Sandbox browser");
    // Each call gets a new sandbox process group. The host-owned browser must
    // survive between them without granting setsid or wider filesystem access.
    expect(await command("read")).toContain("Sandbox browser");
    await command('click "#entry"');
    await command('type "typed-through-broker"');
    expect(await command('click "#apply"')).toContain("typed-through-broker");
    const imageReply = await invokeSession(session.descriptor, { kind: "broker", operation: { kind: "browser", request: { action: "screenshot" } } });
    expect(imageReply.ok, imageReply.text.slice(0, 300)).toBe(true);
    const content = sessionToolResult(imageReply).content;
    const image = content.find(c => c.type === "image");
    expect(image?.type).toBe("image");
    if (image?.type === "image") expect(Buffer.from(image.data, "base64").subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    const body = JSON.parse(imageReply.text) as { result: { path: string } };
    expect(body.result.path.startsWith(workspace)).toBe(true);
    expect(await readFile(sentinel, "utf8")).toBe("unchanged");
    const denied = await invokeSession(session.descriptor, { kind: "broker", operation: { kind: "browser", root: root, request: { action: "open", url: "file:///etc/passwd" } } });
    expect(denied.ok).toBe(false);
    expect(audits).toContain("browser");
    const dirs = await readdir(join(root, "browser-turns"));
    expect(dirs).toHaveLength(1);
    privateRoot = join(root, "browser-turns", dirs[0]!);
    const other = await createSecuritySession({ personaDir: root, persona: "fixture", turnId: "two", policy: { version: 1, enabled: true, grants: [] } });
    try {
      const opened = await invokeSession(other.descriptor, { kind: "broker", operation: { kind: "browser", request: { action: "open", url: `http://127.0.0.1:${server.port}/isolation-check` } } });
      expect(opened.ok, opened.text).toBe(true);
      expect(isolatedCookies).toEqual([""]);
      expect(await readdir(join(root, "browser-turns"))).toHaveLength(2);
    } finally { await other.close(); }
    expect(await command("read")).toContain("Sandbox browser");
  } finally {
    await session.close();
    if (privateRoot) await expect(readFile(join(privateRoot, "endpoint.json"))).rejects.toThrow();
    await server.stop(true);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}, 90_000);
