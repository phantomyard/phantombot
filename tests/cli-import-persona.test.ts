/**
 * Tests for `phantombot import-persona` — including the OpenClaw
 * Telegram-config sniff added in phase 14.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRestore, runImportPersona } from "../src/cli/import-persona.ts";
import type { Config } from "../src/config.ts";
import {
  archivePersona,
  listArchives,
} from "../src/lib/personaArchive.ts";
import type { ServiceControl } from "../src/lib/systemd.ts";

const svcInactive: ServiceControl = {
  isActive: async () => false,
  restart: async () => ({ ok: true }),
};
const svcActive: ServiceControl = {
  isActive: async () => true,
  restart: async () => ({ ok: true }),
};

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
let source: string;
let config: Config;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-imp-"));
  source = join(workdir, "openclaw-agent");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "BOOT.md"), "# id");
  await mkdir(join(workdir, "personas"), { recursive: true });
  config = {
    defaultPersona: "phantom",
    turnTimeoutMs: 600_000,
    personasDir: join(workdir, "personas"),
    memoryDbPath: join(workdir, "memory.sqlite"),
    configPath: join(workdir, "config.toml"),
    harnesses: {
      chain: ["claude"],
      claude: { bin: "claude", model: "opus", fallbackModel: "sonnet" },
      pi: { bin: "pi", maxPayloadBytes: 1_500_000 },
    },
    channels: {},
    embeddings: { provider: "none" },
    voice: { provider: "none" },
  };
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("applyRestore", () => {
  test("restores an archive into personasDir/<asName>/", async () => {
    // Set up: import a persona first, then archive it
    const { mkdir, writeFile, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const personaPath = join(config.personasDir, "kai");
    await mkdir(personaPath, { recursive: true });
    await writeFile(join(personaPath, "BOOT.md"), "# kai original");
    const archive = await archivePersona(config.personasDir, "kai");

    const r = await applyRestore(config, archive, "kai");
    expect(r.name).toBe("kai");
    expect(r.alsoArchived).toBeUndefined();
    const boot = await readFile(join(personaPath, "BOOT.md"), "utf8");
    expect(boot).toBe("# kai original");
  });

  test("auto-archives a persona at the target before restoring", async () => {
    const { mkdir, writeFile, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const personaPath = join(config.personasDir, "kai");
    await mkdir(personaPath, { recursive: true });
    await writeFile(join(personaPath, "BOOT.md"), "# original");
    const archive = await archivePersona(config.personasDir, "kai");
    // Now create a "newer" kai
    await mkdir(personaPath, { recursive: true });
    await writeFile(join(personaPath, "BOOT.md"), "# newer");

    const r = await applyRestore(config, archive, "kai");
    expect(r.alsoArchived).toBeDefined();
    expect(r.alsoArchived?.name).toBe("kai");
    // Now there should be 2 archives in total
    const archives = await listArchives(config.personasDir);
    expect(archives).toHaveLength(2);
    // And the restored content matches the original
    const boot = await readFile(join(personaPath, "BOOT.md"), "utf8");
    expect(boot).toBe("# original");
  });
});

describe("runImportPersona — restart hint", () => {
  test("prints restart hint when phantombot.service is active", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    await runImportPersona({
      source,
      as: "robbie",
      config,
      openclawConfigPath: join(workdir, "missing.json"),
      noTelegram: true,
      serviceControl: svcActive,
      out,
      err,
    });
    expect(out.text).toContain(
      "phantombot is currently running",
    );
    expect(out.text).toContain("systemctl --user restart phantombot");
  });

  test("does NOT print restart hint when phantombot.service is inactive", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    await runImportPersona({
      source,
      as: "robbie",
      config,
      openclawConfigPath: join(workdir, "missing.json"),
      noTelegram: true,
      serviceControl: svcInactive,
      out,
      err,
    });
    expect(out.text).not.toContain("phantombot is currently running");
  });
});

describe("runImportPersona — telegram sniff", () => {
  test("imports telegram block from openclaw.json when present", async () => {
    const openclawPath = join(workdir, "openclaw.json");
    await writeFile(
      openclawPath,
      JSON.stringify({
        channels: {
          telegram: {
            accounts: {
              default: {
                botToken: "111:secret",
                execApprovals: { approvers: ["42"] },
              },
            },
          },
        },
      }),
    );
    const out = new CaptureStream();
    const err = new CaptureStream();
    const code = await runImportPersona({
      source,
      as: "robbie",
      config,
      openclawConfigPath: openclawPath,
      serviceControl: svcInactive,
      out,
      err,
    });
    expect(code).toBe(0);
    expect(out.text).toContain("imported telegram config from");
    const cfg = await readFile(config.configPath, "utf8");
    expect(cfg).toContain("[channels.telegram]");
    expect(cfg).toContain('token = "111:secret"');
    expect(cfg).toContain("allowed_user_ids = [ 42 ]");
  });

  test("does NOT touch config when openclaw.json is missing", async () => {
    const out = new CaptureStream();
    const err = new CaptureStream();
    const code = await runImportPersona({
      source,
      as: "robbie",
      config,
      openclawConfigPath: join(workdir, "missing.json"),
      serviceControl: svcInactive,
      out,
      err,
    });
    expect(code).toBe(0);
    expect(out.text).toContain("(no openclaw telegram config");
    await expect(readFile(config.configPath, "utf8")).rejects.toThrow();
  });

  test("--no-telegram skips the sniff entirely", async () => {
    const openclawPath = join(workdir, "openclaw.json");
    await writeFile(
      openclawPath,
      JSON.stringify({
        channels: {
          telegram: {
            accounts: { default: { botToken: "111:secret" } },
          },
        },
      }),
    );
    const out = new CaptureStream();
    const err = new CaptureStream();
    const code = await runImportPersona({
      source,
      as: "robbie",
      config,
      openclawConfigPath: openclawPath,
      noTelegram: true,
      serviceControl: svcInactive,
      out,
      err,
    });
    expect(code).toBe(0);
    expect(out.text).not.toContain("imported telegram config");
    expect(out.text).not.toContain("(no openclaw telegram config");
    await expect(readFile(config.configPath, "utf8")).rejects.toThrow();
  });
});
