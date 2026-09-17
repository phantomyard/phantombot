/**
 * Native-harness vision: the embedded pi must be able to load photon's WASM
 * on a host that has no build tree.
 *
 * The regression this pins: a compiled phantombot looked for
 * `photon_rs_bg.wasm` at the build machine's node_modules path, beside the
 * executable and in the cwd. None exist on a real host, pi's loadPhoton()
 * swallowed the failure, and every image a native phantom received became
 * "[Image omitted: could not be resized below the inline image size limit.]".
 *
 * The end-to-end test reproduces a real host faithfully: it compiles the
 * binary from a STAGED copy of the checkout and deletes that copy before
 * running, so the path baked into the binary no longer exists.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import {
  EMBEDDED_PHOTON_WASM_PATH,
  installEmbeddedPhotonWasm,
  isPhotonWasmPath,
} from "../src/lib/embeddedPhoton.ts";

const REPO = resolve(import.meta.dir, "..");
const PHOTON_DIR = join(REPO, "node_modules", "@silvia-odwyer", "photon-node");

/** A valid 16x16 red RGB PNG. */
function tinyPng(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(16, 0);
  ihdr.writeUInt32BE(16, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(16).fill([255, 0, 0]).flat())]);
  const raw = Buffer.concat(Array(16).fill(row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("photon wasm path matching", () => {
  test("matches the wasm under any directory, POSIX or Windows, string or file URL", () => {
    expect(isPhotonWasmPath("/home/runner/work/x/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm")).toBe(true);
    expect(isPhotonWasmPath("C:\\a\\b\\photon_rs_bg.wasm")).toBe(true);
    expect(isPhotonWasmPath("photon_rs_bg.wasm")).toBe(true);
    expect(isPhotonWasmPath(new URL("file:///opt/photon_rs_bg.wasm"))).toBe(true);
  });

  test("leaves every other read alone", () => {
    expect(isPhotonWasmPath("/x/not_photon_rs_bg.wasm")).toBe(false);
    expect(isPhotonWasmPath("/x/photon_rs_bg.wasm.bak")).toBe(false);
    expect(isPhotonWasmPath("/x/photon_rs_bg.js")).toBe(false);
    expect(isPhotonWasmPath(3)).toBe(false);
    expect(isPhotonWasmPath(Buffer.from("photon_rs_bg.wasm"))).toBe(false);
  });

  test("from source the embedded path is photon's real wasm", () => {
    expect(existsSync(EMBEDDED_PHOTON_WASM_PATH)).toBe(true);
    expect(EMBEDDED_PHOTON_WASM_PATH.endsWith("photon_rs_bg.wasm")).toBe(true);
  });
});

describe("the redirect", () => {
  test("photon loads from a directory that has no wasm once the redirect is installed", () => {
    // A copy of photon-node WITHOUT its wasm: exactly what a compiled binary
    // sees when its baked __dirname does not exist on the host.
    const dir = mkdtempSync(join(tmpdir(), "phantombot-photon-nowasm-"));
    try {
      for (const f of readdirSync(PHOTON_DIR)) {
        if (f !== "photon_rs_bg.wasm") cpSync(join(PHOTON_DIR, f), join(dir, f));
      }
      const req = createRequire(join(dir, "index.js"));
      installEmbeddedPhotonWasm();
      const photon = req(join(dir, "photon_rs.js")) as {
        PhotonImage: { new_from_byteslice(b: Uint8Array): { get_width(): number } };
      };
      expect(photon.PhotonImage.new_from_byteslice(tinyPng()).get_width()).toBe(16);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Run `__pi` in JSON mode on an image and report what pi put in the user
 * message: the image block, or the omission placeholder. The process is killed
 * as soon as the user message is emitted, so no provider call is needed.
 */
async function userMessageFor(cmd: string[], cwd: string, home: string): Promise<string> {
  writeFileSync(join(cwd, "t.png"), tinyPng());
  const proc = Bun.spawn(
    [...cmd, "--mode", "json", "--no-session", "--provider", "openrouter", "--model", "z-ai/glm-5.3-flash", "-p", "hi", "@t.png"],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: home, PI_OFFLINE: "1", OPENROUTER_API_KEY: "test-no-network" },
    },
  );
  let buf = "";
  const decoder = new TextDecoder();
  try {
    for await (const chunk of proc.stdout) {
      buf += decoder.decode(chunk, { stream: true });
      for (const line of buf.split("\n")) {
        if (line.includes('"type":"message_end"') && line.includes('"role":"user"')) return line;
      }
    }
    throw new Error(`no user message from __pi: ${buf.slice(0, 500)}`);
  } finally {
    proc.kill();
    await proc.exited;
  }
}

describe("compiled binary on a host without a build tree", () => {
  test.skipIf(process.platform !== "linux")(
    "__pi keeps an attached image instead of omitting it",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "phantombot-photon-e2e-"));
      const stage = join(root, "stage");
      const bin = join(root, "bin", "phantombot");
      const work = join(root, "work");
      const home = join(root, "home");
      try {
        mkdirSync(stage);
        mkdirSync(work);
        mkdirSync(home);
        // Hardlink copy (fast) where possible; plain copy otherwise.
        for (const entry of ["src", "scripts", "node_modules", "package.json", "tsconfig.json", "bunfig.toml", "pi-extension", "editors"]) {
          if (!existsSync(join(REPO, entry))) continue;
          const r = spawnSync("cp", ["-al", join(REPO, entry), stage]);
          if (r.status !== 0) cpSync(join(REPO, entry), join(stage, entry), { recursive: true });
        }
        const build = spawnSync(
          process.execPath,
          ["build", "--compile", "./src/index.ts", "--outfile", bin],
          { cwd: stage, encoding: "utf8" },
        );
        expect(build.status, build.stderr).toBe(0);
        // The host has no build tree: the path baked into the binary is gone.
        rmSync(stage, { recursive: true, force: true });

        const line = await userMessageFor([bin, "__pi"], work, home);
        expect(line).not.toContain("Image omitted");
        expect(line).toContain('"type":"image"');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
