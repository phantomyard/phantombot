/**
 * Shared per-persona identity (identity.json) — the root secret both the
 * phantomchat channel and the encrypted vault derive from (PR #253).
 *
 * Covers:
 *   - fresh generation, 0600 perms, and idempotency,
 *   - legacy MIGRATION of an nsec out of phantomchat.json into identity.json,
 *   - identity.json PRECEDENCE over a legacy phantomchat.json nsec,
 *   - the concurrent-create RACE: many parallel first-use calls must converge
 *     on ONE nsec (a divergent write would orphan a vault forever).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateIdentity } from "../src/lib/nostrIdentity.ts";
import {
  getOrCreatePersonaIdentity,
  personaIdentityPath,
  readPersonaIdentityNsec,
  writePersonaIdentity,
} from "../src/lib/personaIdentity.ts";

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-identity-"));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("getOrCreatePersonaIdentity", () => {
  test("generates, persists identity.json at mode 0600, returns a valid identity", async () => {
    const dir = join(workdir, "p");
    const identity = await getOrCreatePersonaIdentity(dir);

    expect(identity.nsec).toMatch(/^nsec1/);
    expect(identity.npub).toMatch(/^npub1/);
    expect(identity.secretKey.length).toBe(32);

    const st = await stat(personaIdentityPath(dir));
    expect(st.mode & 0o777).toBe(0o600);
    expect(readPersonaIdentityNsec(dir)).toBe(identity.nsec);
  });

  test("is idempotent — a second call returns the same nsec", async () => {
    const dir = join(workdir, "p");
    const first = await getOrCreatePersonaIdentity(dir);
    const second = await getOrCreatePersonaIdentity(dir);
    expect(second.nsec).toBe(first.nsec);
  });

  test("migrates a legacy phantomchat.json nsec into identity.json", async () => {
    const dir = join(workdir, "p");
    await mkdir(dir, { recursive: true });
    const legacy = generateIdentity();
    await writeFile(
      join(dir, "phantomchat.json"),
      JSON.stringify({ nsec: legacy.nsec, relays: [] }),
    );

    const identity = await getOrCreatePersonaIdentity(dir);
    expect(identity.nsec).toBe(legacy.nsec); // same identity preserved
    expect(readPersonaIdentityNsec(dir)).toBe(legacy.nsec); // now in identity.json
  });

  test("identity.json takes precedence over a legacy phantomchat.json nsec", async () => {
    const dir = join(workdir, "p");
    await mkdir(dir, { recursive: true });
    const shared = generateIdentity();
    const legacy = generateIdentity();
    await writePersonaIdentity(dir, shared.nsec);
    await writeFile(
      join(dir, "phantomchat.json"),
      JSON.stringify({ nsec: legacy.nsec }),
    );

    const identity = await getOrCreatePersonaIdentity(dir);
    expect(identity.nsec).toBe(shared.nsec);
  });

  test("concurrent first-use calls all converge on ONE nsec (no divergent write)", async () => {
    const dir = join(workdir, "p");
    const results = await Promise.all(
      Array.from({ length: 12 }, () => getOrCreatePersonaIdentity(dir)),
    );
    const nsecs = new Set(results.map((r) => r.nsec));
    expect(nsecs.size).toBe(1); // exactly one identity won the race
    // And it's the one persisted on disk.
    expect(readPersonaIdentityNsec(dir)).toBe(results[0]!.nsec);
  });
});

describe("readPersonaIdentityNsec / writePersonaIdentity", () => {
  test("read returns undefined before write, the value after", async () => {
    const dir = join(workdir, "p");
    expect(readPersonaIdentityNsec(dir)).toBeUndefined();
    const id = generateIdentity();
    await writePersonaIdentity(dir, id.nsec);
    expect(readPersonaIdentityNsec(dir)).toBe(id.nsec);
  });

  test("writePersonaIdentity persists at mode 0600", async () => {
    const dir = join(workdir, "p");
    await writePersonaIdentity(dir, generateIdentity().nsec);
    const st = await stat(personaIdentityPath(dir));
    expect(st.mode & 0o777).toBe(0o600);
  });
});
