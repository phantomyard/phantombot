/**
 * Read persona files from an agent directory.
 *
 * Phantombot accepts the naming conventions in use across the OpenClaw
 * ecosystem so personas can move freely between systems.
 *
 * The identity content the harness sees is composed of up to two parts,
 * concatenated in this order when both are present:
 *
 *   SOUL.md      — the shared, character-free behaviour anchor ("how you
 *                  operate": conciseness, persistence, trust, voice). Every
 *                  modern persona gets one.
 *   facts        — the per-phantom "who you are", first match wins:
 *                    BOOT.md     (Robbie / original-phantombot convention:
 *                                 a single combined identity+behaviour file)
 *                    IDENTITY.md (modern split convention)
 *
 * Backward compatibility:
 *   - A persona with only BOOT.md loads exactly as before (BOOT.md is the
 *     facts file; no SOUL.md to prepend).
 *   - A persona with only SOUL.md (e.g. Robbie today) loads SOUL.md as its
 *     whole identity.
 *   - A persona with SOUL.md + IDENTITY.md (or SOUL.md + BOOT.md) gets BOTH,
 *     concatenated — this is the split the onboarding + backfill produce.
 *   - At least one of SOUL.md / BOOT.md / IDENTITY.md must exist, else
 *     PersonaNotFoundError.
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

const SOUL_FILE = "SOUL.md" as const;
/** Per-phantom "who you are" file — first match wins. */
const FACTS_FILES = ["BOOT.md", "IDENTITY.md"] as const;
/** All files that can supply identity content (for the not-found message). */
const IDENTITY_FILES = [SOUL_FILE, ...FACTS_FILES] as const;
const MEMORY_FILES = ["MEMORY.md"] as const;
const TOOLS_FILES = ["tools.md", "AGENTS.md"] as const;

export interface PersonaFiles {
  /**
   * Identity content shown to the harness. Concatenation of the per-phantom
   * facts file (BOOT.md / IDENTITY.md) followed by SOUL.md, whichever are
   * present.
   */
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
  // Per-phantom "who you are" (BOOT.md legacy-combined, or IDENTITY.md).
  const facts = await tryReadFirst(agentDir, FACTS_FILES);
  // Shared "how you operate" anchor.
  const soul = await tryReadFirst(agentDir, [SOUL_FILE]);

  if (!facts && !soul) throw new PersonaNotFoundError(agentDir);

  // Facts first (who), then soul (how). Either may be absent.
  const parts = [facts?.content, soul?.content].filter(
    (c): c is string => typeof c === "string",
  );
  const sources = [facts?.source, soul?.source].filter(
    (s): s is string => typeof s === "string",
  );

  const memory = await tryReadFirst(agentDir, MEMORY_FILES);
  const tools = await tryReadFirst(agentDir, TOOLS_FILES);

  return {
    boot: parts.join("\n\n"),
    identitySource: sources.join("+"),
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
