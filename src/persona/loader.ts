/**
 * Read persona files from an agent directory.
 *
 * Phantombot accepts both naming conventions in use across the OpenClaw
 * ecosystem so personas can move freely between systems:
 *
 *   identity (required) — first match wins:
 *     BOOT.md     (Robbie convention; original phantombot placeholders use this)
 *     SOUL.md     (modern OpenClaw)
 *     IDENTITY.md (modern OpenClaw)
 *
 *   persistent memory (optional):
 *     MEMORY.md
 *
 *   tools / hints (optional) — first match wins:
 *     tools.md
 *     AGENTS.md   (modern OpenClaw)
 *
 * Anything else under the agent dir is ignored by the loader but available
 * to the harness's own tools — the harness's working directory is set to
 * agentDir, so e.g. claude can `Read` arbitrary files there.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const IDENTITY_FILES = ["BOOT.md", "SOUL.md", "IDENTITY.md"] as const;
const MEMORY_FILES = ["MEMORY.md"] as const;
const TOOLS_FILES = ["tools.md", "AGENTS.md"] as const;

export interface PersonaFiles {
  /** Identity content (from BOOT.md / SOUL.md / IDENTITY.md). */
  boot: string;
  /** Always-in-context notes (from MEMORY.md). */
  memory?: string;
  /** Tool / capability hints (from tools.md / AGENTS.md). */
  tools?: string;

  /** Filename the identity content was loaded from (diagnostic). */
  identitySource: string;
  /** Filename the memory content was loaded from, if any (diagnostic). */
  memorySource?: string;
  /** Filename the tools content was loaded from, if any (diagnostic). */
  toolsSource?: string;
}

export class PersonaNotFoundError extends Error {
  constructor(agentDir: string) {
    super(
      `No identity file found in ${agentDir}. Expected one of: ${IDENTITY_FILES.join(", ")}`,
    );
    this.name = "PersonaNotFoundError";
  }
}

export async function loadPersona(agentDir: string): Promise<PersonaFiles> {
  const identity = await tryReadFirst(agentDir, IDENTITY_FILES);
  if (!identity) throw new PersonaNotFoundError(agentDir);

  const memory = await tryReadFirst(agentDir, MEMORY_FILES);
  const tools = await tryReadFirst(agentDir, TOOLS_FILES);

  return {
    boot: identity.content,
    identitySource: identity.source,
    memory: memory?.content,
    memorySource: memory?.source,
    tools: tools?.content,
    toolsSource: tools?.source,
  };
}

async function tryReadFirst(
  dir: string,
  names: readonly string[],
): Promise<{ content: string; source: string } | undefined> {
  for (const name of names) {
    try {
      const content = await readFile(join(dir, name), "utf8");
      return { content, source: name };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return undefined;
}
