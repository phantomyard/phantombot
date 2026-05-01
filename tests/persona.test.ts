/**
 * Tests for the persona loader.
 *
 * Covers both the legacy BOOT.md / MEMORY.md / tools.md naming (Robbie
 * convention used by the original phantombot placeholders) and the newer
 * OpenClaw SOUL.md / IDENTITY.md / AGENTS.md naming.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PersonaNotFoundError,
  loadPersona,
} from "../src/persona/loader.ts";

let agentDir: string;

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "phantombot-persona-"));
});

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true });
});

async function write(name: string, content: string): Promise<void> {
  await writeFile(join(agentDir, name), content, "utf8");
}

describe("loadPersona — identity file naming", () => {
  test("loads BOOT.md (Robbie convention)", async () => {
    await write("BOOT.md", "# I am Robbie");
    const p = await loadPersona(agentDir);
    expect(p.boot).toBe("# I am Robbie");
    expect(p.identitySource).toBe("BOOT.md");
  });

  test("loads SOUL.md (modern OpenClaw)", async () => {
    await write("SOUL.md", "# Soul");
    const p = await loadPersona(agentDir);
    expect(p.boot).toBe("# Soul");
    expect(p.identitySource).toBe("SOUL.md");
  });

  test("loads IDENTITY.md (modern OpenClaw)", async () => {
    await write("IDENTITY.md", "# Identity");
    const p = await loadPersona(agentDir);
    expect(p.boot).toBe("# Identity");
    expect(p.identitySource).toBe("IDENTITY.md");
  });

  test("BOOT.md wins over SOUL.md when both exist", async () => {
    await write("BOOT.md", "from BOOT");
    await write("SOUL.md", "from SOUL");
    const p = await loadPersona(agentDir);
    expect(p.boot).toBe("from BOOT");
    expect(p.identitySource).toBe("BOOT.md");
  });

  test("SOUL.md wins over IDENTITY.md when BOOT.md is absent", async () => {
    await write("SOUL.md", "from SOUL");
    await write("IDENTITY.md", "from IDENTITY");
    const p = await loadPersona(agentDir);
    expect(p.boot).toBe("from SOUL");
    expect(p.identitySource).toBe("SOUL.md");
  });

  test("throws PersonaNotFoundError when no identity file exists", async () => {
    await write("MEMORY.md", "just memory");
    await write("tools.md", "just tools");
    expect(loadPersona(agentDir)).rejects.toThrow(PersonaNotFoundError);
  });
});

describe("loadPersona — memory file", () => {
  test("loads MEMORY.md when present", async () => {
    await write("BOOT.md", "id");
    await write("MEMORY.md", "I remember things");
    const p = await loadPersona(agentDir);
    expect(p.memory).toBe("I remember things");
    expect(p.memorySource).toBe("MEMORY.md");
  });

  test("memory is undefined when MEMORY.md is absent", async () => {
    await write("BOOT.md", "id");
    const p = await loadPersona(agentDir);
    expect(p.memory).toBeUndefined();
    expect(p.memorySource).toBeUndefined();
  });
});

describe("loadPersona — tools file naming", () => {
  test("loads tools.md when present", async () => {
    await write("BOOT.md", "id");
    await write("tools.md", "shell, ssh, etc");
    const p = await loadPersona(agentDir);
    expect(p.tools).toBe("shell, ssh, etc");
    expect(p.toolsSource).toBe("tools.md");
  });

  test("loads AGENTS.md when present", async () => {
    await write("BOOT.md", "id");
    await write("AGENTS.md", "agent hints");
    const p = await loadPersona(agentDir);
    expect(p.tools).toBe("agent hints");
    expect(p.toolsSource).toBe("AGENTS.md");
  });

  test("tools.md wins over AGENTS.md when both exist", async () => {
    await write("BOOT.md", "id");
    await write("tools.md", "from tools");
    await write("AGENTS.md", "from AGENTS");
    const p = await loadPersona(agentDir);
    expect(p.tools).toBe("from tools");
    expect(p.toolsSource).toBe("tools.md");
  });

  test("tools is undefined when neither file is present", async () => {
    await write("BOOT.md", "id");
    const p = await loadPersona(agentDir);
    expect(p.tools).toBeUndefined();
    expect(p.toolsSource).toBeUndefined();
  });
});

describe("loadPersona — full mixed persona", () => {
  test("loads all three slots from a SOUL/MEMORY/AGENTS persona", async () => {
    await write("SOUL.md", "soul content");
    await write("MEMORY.md", "memory content");
    await write("AGENTS.md", "agents content");
    const p = await loadPersona(agentDir);
    expect(p).toEqual({
      boot: "soul content",
      identitySource: "SOUL.md",
      memory: "memory content",
      memorySource: "MEMORY.md",
      tools: "agents content",
      toolsSource: "AGENTS.md",
    });
  });
});
