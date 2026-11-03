/**
 * `phantombot phantomchat --list` / `--allow`: the non-interactive modes a
 * desktop app's Scan uses. Everything runs in a temp personas dir.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runPhantomchatScripted } from "../src/cli/phantomchat.ts";
import type { Config } from "../src/config.ts";
import { savePhantomchatPersonaConfig } from "../src/channels/phantomchat/personaStore.ts";
import { generateIdentity } from "../src/lib/nostrIdentity.ts";

let root: string;
let config: Config;
const relays = async () => ["wss://relay.test"];

function sink() {
  let text = "";
  return { write: (s: string) => ((text += s), true), get text() { return text; } };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pb-pc-scripted-"));
  config = { personasDir: join(root, "personas") } as unknown as Config;
  mkdirSync(join(config.personasDir, "lena"), { recursive: true });
  mkdirSync(join(config.personasDir, "kai"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function list(): Promise<Array<Record<string, unknown>>> {
  const out = sink();
  expect(await runPhantomchatScripted({ list: true, json: true, config, out })).toBe(0);
  return JSON.parse(out.text);
}

describe("phantomchat --list", () => {
  test("reports every persona, npub only when it has one, and never mints a key", async () => {
    const lena = generateIdentity();
    const owner = generateIdentity();
    await savePhantomchatPersonaConfig(join(config.personasDir, "lena"), {
      nsec: lena.nsec,
      relays: ["wss://r"],
      allowedNpubs: [owner.npub],
    });
    const rows = await list();
    expect(rows).toEqual([
      { persona: "kai", npub: null, phantomchat: false, allowedNpubs: [] },
      { persona: "lena", npub: lena.npub, phantomchat: true, allowedNpubs: [owner.npub] },
    ]);
    expect(existsSync(join(config.personasDir, "kai", "identity.json"))).toBe(false);
    // The output never carries a secret.
    expect(JSON.stringify(rows)).not.toContain("nsec");
  });
});

describe("phantomchat --allow", () => {
  test("sets the channel up on a bare persona and adds the npub, idempotently", async () => {
    const owner = generateIdentity();
    const out = sink();
    const run = () =>
      runPhantomchatScripted({ list: false, allow: owner.npub, persona: "kai", json: true, config, out, fetchRelays: relays });
    expect(await run()).toBe(0);
    const first = JSON.parse(out.text.trim().split("\n")[0]!);
    expect(first.added).toBe(true);
    expect(first.npub).toMatch(/^npub1/);

    const rows = await list();
    const kai = rows.find((r) => r.persona === "kai")!;
    expect(kai).toEqual({ persona: "kai", npub: first.npub, phantomchat: true, allowedNpubs: [owner.npub] });
    const file = JSON.parse(readFileSync(join(config.personasDir, "kai", "phantomchat.json"), "utf8"));
    expect(file.tofu).toBeUndefined();
    expect(file.relays).toEqual(["wss://relay.test"]);

    expect(await run()).toBe(0);
    const second = JSON.parse(out.text.trim().split("\n")[1]!);
    expect(second).toEqual({ persona: "kai", npub: first.npub, added: false });
    expect((await list()).find((r) => r.persona === "kai")!.allowedNpubs).toEqual([owner.npub]);
  });

  test("appends to an existing allowlist and keeps the persona's npub", async () => {
    const lena = generateIdentity();
    const a = generateIdentity();
    const b = generateIdentity();
    await savePhantomchatPersonaConfig(join(config.personasDir, "lena"), {
      nsec: lena.nsec,
      relays: ["wss://r"],
      allowedNpubs: [a.npub],
      greeted: [a.npub],
    });
    const out = sink();
    expect(
      await runPhantomchatScripted({ list: false, allow: b.npub, persona: "lena", json: true, config, out, fetchRelays: relays }),
    ).toBe(0);
    expect(JSON.parse(out.text)).toEqual({ persona: "lena", npub: lena.npub, added: true });
    const file = JSON.parse(readFileSync(join(config.personasDir, "lena", "phantomchat.json"), "utf8"));
    expect(file.allowed_npubs).toEqual([a.npub, b.npub]);
    expect(file.greeted).toEqual([a.npub]);
  });

  test("rejects a bad npub, hex, a missing or unknown persona, and --list with --allow", async () => {
    const owner = generateIdentity();
    const cases: Array<[Parameters<typeof runPhantomchatScripted>[0], string]> = [
      [{ list: false, allow: "npub1garbage", persona: "kai", json: true }, "not a valid npub"],
      [{ list: false, allow: owner.publicKeyHex, persona: "kai", json: true }, "not a valid npub"],
      [{ list: false, allow: `${owner.npub},${owner.npub}`, persona: "kai", json: true }, "not a valid npub"],
      [{ list: false, allow: owner.npub, json: true }, "needs --persona"],
      [{ list: false, allow: owner.npub, persona: "nobody", json: true }, "no persona 'nobody'"],
      [{ list: false, allow: owner.npub, persona: "../kai", json: true }, "no persona"],
      [{ list: true, allow: owner.npub, persona: "kai", json: true }, "cannot be combined"],
    ];
    for (const [input, message] of cases) {
      const err = sink();
      expect(await runPhantomchatScripted({ ...input, config, err, out: sink(), fetchRelays: relays })).toBe(2);
      expect(err.text).toContain(message);
    }
    expect(existsSync(join(config.personasDir, "kai", "phantomchat.json"))).toBe(false);
    expect(existsSync(join(config.personasDir, "kai", "identity.json"))).toBe(false);
  });
});
