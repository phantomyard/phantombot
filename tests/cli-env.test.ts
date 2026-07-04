/**
 * `phantombot env` is now a DEPRECATED ALIAS that forwards to the encrypted
 * vault (src/cli/vault.ts). These tests pin two things:
 *   - the deprecation notice is printed to stderr (never stdout, which carries
 *     values), and
 *   - each runner forwards to the vault so a set/get/list/unset round-trips
 *     through the encrypted store with the same value/name hygiene as before.
 *
 * The runners accept an injectable `vault` seam (mirroring the vault runners),
 * so we drive them against an in-memory persona vault with no filesystem env
 * file at all.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runEnvGet,
  runEnvList,
  runEnvSet,
  runEnvUnset,
} from "../src/cli/env.ts";
import {
  runVaultGet,
  runVaultList,
  runVaultSet,
  runVaultUnset,
} from "../src/cli/vault.ts";
import { openVaultWithSecret, type Vault } from "../src/lib/vault.ts";
import { generateSecretKey } from "nostr-tools/pure";

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
let vault: Vault;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-env-cli-"));
  vault = openVaultWithSecret(join(workdir, "persona"), generateSecretKey());
});

afterEach(async () => {
  vault.close();
  await rm(workdir, { recursive: true, force: true });
});

describe("runEnvSet (deprecated → vault)", () => {
  test("forwards to the vault; ack names the var only, notice on stderr", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const code = await runEnvSet({
      name: "GITHUB_TOKEN",
      value: "ghp_supersecret",
      vault,
      out,
      err,
    });
    expect(code).toBe(0);
    // Deprecation notice on stderr, not stdout.
    expect(err.text).toMatch(/deprecated/i);
    expect(out.text).not.toMatch(/deprecated/i);
    // Ack mentions the name but NOT the value (hygiene rule).
    expect(out.text).toContain("GITHUB_TOKEN");
    expect(out.text).not.toContain("ghp_supersecret");
    // The value actually landed in the encrypted vault.
    expect(vault.get("GITHUB_TOKEN")).toBe("ghp_supersecret");
  });

  test("rejects invalid env var names", async () => {
    const err = new CaptureStream();
    const code = await runEnvSet({ name: "weird-name", value: "x", vault, err });
    expect(code).toBe(2);
    expect(err.text).toContain("not a valid env var name");
  });

  test("set is idempotent — replaces the value, one entry", async () => {
    await runEnvSet({ name: "K", value: "v1", vault, out: new CaptureStream(), err: new CaptureStream() });
    await runEnvSet({ name: "K", value: "v2", vault, out: new CaptureStream(), err: new CaptureStream() });
    expect(vault.get("K")).toBe("v2");
    expect(vault.list()).toEqual(["K"]);
  });
});

describe("runEnvGet (deprecated → vault)", () => {
  test("prints raw value when set", async () => {
    vault.set("TOKEN", "hello");
    const out = new CaptureStream();
    const code = await runEnvGet({ name: "TOKEN", vault, out });
    expect(code).toBe(0);
    expect(out.text).toBe("hello\n");
  });

  test("exit 1 when not set", async () => {
    const err = new CaptureStream();
    const code = await runEnvGet({ name: "MISSING", vault, err });
    expect(code).toBe(1);
    expect(err.text).toContain("not set");
  });
});

describe("runEnvList (deprecated → vault)", () => {
  test("prints names only, sorted, never values", async () => {
    vault.set("ZED", "z");
    vault.set("ALPHA", "a");
    vault.set("MID", "m");
    const out = new CaptureStream();
    const code = await runEnvList({ vault, out });
    expect(code).toBe(0);
    expect(out.text).toBe("ALPHA\nMID\nZED\n");
    expect(out.text).not.toContain("=");
  });

  test("empty vault → friendly placeholder", async () => {
    const out = new CaptureStream();
    const code = await runEnvList({ vault, out });
    expect(code).toBe(0);
    expect(out.text).toContain("(no entries");
  });
});

describe("runEnvUnset (deprecated → vault)", () => {
  test("removes the entry, leaves others intact", async () => {
    vault.set("KEEP", "k");
    vault.set("GONE", "g");
    const out = new CaptureStream();
    const code = await runEnvUnset({ name: "GONE", vault, out });
    expect(code).toBe(0);
    expect(out.text).toContain("removed GONE");
    expect(vault.get("KEEP")).toBe("k");
    expect(vault.get("GONE")).toBeUndefined();
  });

  test("rejects invalid names without touching the vault", async () => {
    const err = new CaptureStream();
    const code = await runEnvUnset({ name: "1bad", vault, err });
    expect(code).toBe(2);
    expect(err.text).toContain("not a valid");
  });
});

// The vault runners are the forward target; a quick direct check that they
// behave identically (the env runners just prepend a deprecation notice).
describe("vault runners (forward target)", () => {
  test("set/get/list/unset round-trip through the encrypted vault", async () => {
    const out = new CaptureStream();
    expect(await runVaultSet({ name: "A", value: "1", vault, out })).toBe(0);
    expect(out.text).toContain("saved A");
    expect(out.text).not.toContain("1\n"); // value not echoed in the ack

    const getOut = new CaptureStream();
    expect(await runVaultGet({ name: "A", vault, out: getOut })).toBe(0);
    expect(getOut.text).toBe("1\n");

    const listOut = new CaptureStream();
    expect(await runVaultList({ vault, out: listOut })).toBe(0);
    expect(listOut.text).toBe("A\n");

    const unsetOut = new CaptureStream();
    expect(await runVaultUnset({ name: "A", vault, out: unsetOut })).toBe(0);
    expect(vault.get("A")).toBeUndefined();
  });
});
