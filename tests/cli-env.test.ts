import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runEnvGet,
  runEnvList,
  runEnvSet,
  runEnvUnset,
} from "../src/cli/env.ts";

class CaptureStream {
  chunks: string[] = [];
  write(s: string | Uint8Array): boolean {
    this.chunks.push(typeof s === "string" ? s : new TextDecoder().decode(s));
    return true;
  }
  get text(): string {
    return this.chunks.join("");
  }
}

let workdir: string;
let envPath: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-env-cli-"));
  envPath = join(workdir, ".env");
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("runEnvSet", () => {
  test("writes the var, file is mode 0o600, ack message names the var only", async () => {
    const out = new CaptureStream();
    const code = await runEnvSet({
      name: "GITHUB_TOKEN",
      value: "ghp_supersecret",
      envPath,
      out,
    });
    expect(code).toBe(0);
    // File mode is owner-only (the existing envFile.ts atomic-rename guarantee).
    const s = await stat(envPath);
    expect((s.mode & 0o077).toString(8)).toBe("0");
    // Ack mentions the name but NOT the value (hygiene rule).
    expect(out.text).toContain("GITHUB_TOKEN");
    expect(out.text).not.toContain("ghp_supersecret");
    // Round-trip via a real read.
    const content = await readFile(envPath, "utf8");
    expect(content).toContain("GITHUB_TOKEN=ghp_supersecret");
  });

  test("rejects invalid env var names", async () => {
    const err = new CaptureStream();
    const code = await runEnvSet({
      name: "weird-name",
      value: "x",
      envPath,
      err,
    });
    expect(code).toBe(2);
    expect(err.text).toContain("not a valid env var name");
  });

  test("set is idempotent — replaces existing entries, no duplicates", async () => {
    await runEnvSet({ name: "K", value: "v1", envPath, out: new CaptureStream() });
    await runEnvSet({ name: "K", value: "v2", envPath, out: new CaptureStream() });
    const text = await readFile(envPath, "utf8");
    // Exactly one K= line.
    const matches = text.match(/^K=/gm);
    expect(matches?.length).toBe(1);
    expect(text).toContain("K=v2");
  });
});

describe("runEnvGet", () => {
  test("prints raw value when set", async () => {
    await writeFile(envPath, "TOKEN=hello\n", { encoding: "utf8", mode: 0o600 });
    const out = new CaptureStream();
    const code = await runEnvGet({ name: "TOKEN", envPath, out });
    expect(code).toBe(0);
    expect(out.text).toBe("hello\n");
  });

  test("exit 1 when not set", async () => {
    const err = new CaptureStream();
    const code = await runEnvGet({ name: "MISSING", envPath, err });
    expect(code).toBe(1);
    expect(err.text).toContain("not set");
  });
});

describe("runEnvList", () => {
  test("prints names only, sorted, never values", async () => {
    await writeFile(
      envPath,
      "ZED=z\nALPHA=a\nMID=m\n",
      { encoding: "utf8", mode: 0o600 },
    );
    const out = new CaptureStream();
    const code = await runEnvList({ envPath, out });
    expect(code).toBe(0);
    expect(out.text).toBe("ALPHA\nMID\nZED\n");
    expect(out.text).not.toContain("=");
  });

  test("empty file → friendly placeholder", async () => {
    const out = new CaptureStream();
    const code = await runEnvList({ envPath, out });
    expect(code).toBe(0);
    expect(out.text).toContain("(no entries");
  });
});

describe("runEnvUnset", () => {
  test("removes the entry, leaves others intact", async () => {
    await writeFile(
      envPath,
      "KEEP=k\nGONE=g\n",
      { encoding: "utf8", mode: 0o600 },
    );
    const out = new CaptureStream();
    const code = await runEnvUnset({ name: "GONE", envPath, out });
    expect(code).toBe(0);
    expect(out.text).toContain("removed GONE");
    const text = await readFile(envPath, "utf8");
    expect(text).toContain("KEEP=k");
    expect(text).not.toContain("GONE=");
  });

  test("rejects invalid names without touching the file", async () => {
    const err = new CaptureStream();
    const code = await runEnvUnset({ name: "1bad", envPath, err });
    expect(code).toBe(2);
    expect(err.text).toContain("not a valid");
  });
});
