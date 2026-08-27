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
import { Readable } from "node:stream";
import {
  runEnvGet,
  runEnvList,
  runEnvSet,
  runEnvUnset,
} from "../src/cli/env.ts";
import vaultCommand, {
  runVaultGet,
  runVaultList,
  readVaultValueFromStdin,
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

describe("config.toml settings are refused by the vault CLI (#465)", () => {
  test("runVaultSet rejects a retired mirror and stores nothing", async () => {
    // Without this the CLI would print "saved … to the vault" and the daemon
    // would withhold (and possibly delete) the row on its next read — the
    // exact silent revert the read-time guard exists to kill, at the one
    // moment there is an operator standing here to be told instead.
    const out = new CaptureStream();
    const err = new CaptureStream();
    const code = await runVaultSet({
      name: "PHANTOMBOT_PRIMARY_MODEL",
      value: "z-ai/glm-5.3-flash",
      vault,
      out,
      err,
    });
    expect(code).toBe(2);
    expect(out.text).toBe("");
    expect(err.text).toMatch(/phantombot harness/);
    expect(err.text).toMatch(/config\.toml/);
    expect(vault.get("PHANTOMBOT_PRIMARY_MODEL")).toBeUndefined();
  });

  test("the per-persona suffixed form is refused too", async () => {
    const err = new CaptureStream();
    const code = await runVaultSet({
      name: "PHANTOMBOT_CODING_MODEL_LENA",
      value: "z-ai/glm-5.3-flash",
      vault,
      out: new CaptureStream(),
      err,
    });
    expect(code).toBe(2);
    expect(vault.get("PHANTOMBOT_CODING_MODEL_LENA")).toBeUndefined();
  });

  test("the deprecated `phantombot env set` alias is refused as well", async () => {
    // This is the spelling every pre-#452 runbook still gives, so it is the
    // path an operator actually reaches by habit.
    const err = new CaptureStream();
    const code = await runEnvSet({
      name: "PHANTOMBOT_PRIMARY_MODEL",
      value: "z-ai/glm-5.3-flash",
      vault,
      out: new CaptureStream(),
      err,
    });
    expect(code).toBe(2);
    expect(vault.get("PHANTOMBOT_PRIMARY_MODEL")).toBeUndefined();
  });

  test("a real secret whose name merely SHARES a prefix still saves", async () => {
    // Scope guard on the structural `<BASE>_<SUFFIX>` match: PHANTOMBOT_PI_BIN
    // and PHANTOMBOT_PI_PROVIDER are mirrors, PHANTOMBOT_PI_API_KEY is a
    // genuine credential and must keep working.
    const code = await runVaultSet({
      name: "PHANTOMBOT_PI_API_KEY",
      value: "sk-real-credential",
      vault,
      out: new CaptureStream(),
      err: new CaptureStream(),
    });
    expect(code).toBe(0);
    expect(vault.get("PHANTOMBOT_PI_API_KEY")).toBe("sk-real-credential");
  });
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

  test("set reads an omitted value from stdin and trims one trailing newline", async () => {
    const stdin = Readable.from(["first line\nsecond line\n\n"]);
    expect(
      await runVaultSet({ name: "PIPE_TOKEN", vault, stdin, out: new CaptureStream() }),
    ).toBe(0);
    expect(vault.get("PIPE_TOKEN")).toBe("first line\nsecond line\n");
  });

  test("an explicit positional value is unchanged, including trailing newlines", async () => {
    await runVaultSet({
      name: "POSITIONAL_TOKEN",
      value: "legacy-value\n",
      vault,
      out: new CaptureStream(),
    });
    expect(vault.get("POSITIONAL_TOKEN")).toBe("legacy-value\n");
  });

  test.each([
    ["empty stdin", Readable.from([])],
    ["newline-only stdin", Readable.from(["\n"])],
  ])("%s is rejected without overwriting an existing secret", async (_label, stdin) => {
    vault.set("TOKEN", "existing-value");
    const err = new CaptureStream();
    expect(await runVaultSet({ name: "TOKEN", vault, stdin, err })).toBe(2);
    expect(err.text).toContain("stdin was empty");
    expect(err.text).toContain("--allow-empty");
    expect(vault.get("TOKEN")).toBe("existing-value");
  });

  test("--allow-empty permits an intentional empty stdin value", async () => {
    vault.set("TOKEN", "existing-value");
    expect(
      await runVaultSet({
        name: "TOKEN",
        vault,
        stdin: Readable.from([]),
        allowEmpty: true,
        out: new CaptureStream(),
      }),
    ).toBe(0);
    expect(vault.get("TOKEN")).toBe("");
  });

  test("an explicit empty positional value remains supported", async () => {
    vault.set("TOKEN", "existing-value");
    expect(
      await runVaultSet({ name: "TOKEN", value: "", vault, out: new CaptureStream() }),
    ).toBe(0);
    expect(vault.get("TOKEN")).toBe("");
  });

  test("omitted value refuses a TTY instead of hanging", async () => {
    const err = new CaptureStream();
    const stdin = Object.assign(Readable.from([]), { isTTY: true });
    expect(await runVaultSet({ name: "TOKEN", vault, stdin, err })).toBe(2);
    expect(err.text).toContain("stdin is a TTY");
    expect(vault.get("TOKEN")).toBeUndefined();
  });
});

describe("readVaultValueFromStdin", () => {
  test("strips one LF or CRLF but preserves content without a line ending", async () => {
    expect(await readVaultValueFromStdin(Readable.from(["secret\n"]))).toBe("secret");
    expect(await readVaultValueFromStdin(Readable.from(["secret\r\n"]))).toBe("secret");
    expect(await readVaultValueFromStdin(Readable.from(["secret"]))).toBe("secret");
  });
});

describe("vault set command contract", () => {
  test("the value positional is optional so omission reaches stdin handling", () => {
    const subCommands = vaultCommand.subCommands as unknown as Record<
      string,
      { args?: Record<string, { required?: boolean; type?: string }> }
    >;
    const setCommand = subCommands.set!;
    expect(setCommand.args?.value?.required).toBe(false);
    expect(setCommand.args?.allowEmpty?.type).toBe("boolean");
  });
});
