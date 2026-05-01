/**
 * Read persona files (BOOT.md, MEMORY.md, etc.) from an agent directory.
 *
 * Agent layout convention (matches the OpenClaw conventions used in
 * ~/clawd/ so persona files can be moved across without edits):
 *
 *   <agentDir>/
 *     BOOT.md       — identity, role, response style. Required.
 *     MEMORY.md     — durable notes the persona always sees. Optional.
 *     tools.md      — descriptive list of tools the harness should use
 *                     (NOT a tool-call schema — just hints in markdown).
 *                     Optional.
 *
 * Anything else under the agent dir is ignored by the loader but available
 * to the harness's own tools (the harness's working directory is set to
 * agentDir, so e.g. claude can `Read` arbitrary files there).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface PersonaFiles {
  boot: string; // required
  memory?: string;
  tools?: string;
}

export async function loadPersona(agentDir: string): Promise<PersonaFiles> {
  const boot = await readFile(join(agentDir, "BOOT.md"), "utf8");
  const memory = await tryRead(join(agentDir, "MEMORY.md"));
  const tools = await tryRead(join(agentDir, "tools.md"));
  return { boot, memory, tools };
}

async function tryRead(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}
