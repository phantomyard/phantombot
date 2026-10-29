/**
 * The escort's orchestrator wiring (issue #702). A screen that PASSES an
 * untrusted turn with escort settings (decision model configured) makes the
 * turn hand every harness an escort context, and only harnesses that can
 * enforce it run; none left ⇒ the turn is held. No escort settings ⇒ the
 * turn runs exactly as before. Trusted turns are never escorted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTurn } from "../src/orchestrator/turn.ts";
import type { ScreenVerdict } from "../src/orchestrator/screen.ts";
import { type MemoryStore, openMemoryStore } from "../src/memory/store.ts";
import type { Harness, HarnessChunk, HarnessRequest } from "../src/harnesses/types.ts";
import type { EscortSettings } from "../src/lib/escort.ts";

let agentDir: string;
let memory: MemoryStore;

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "phantombot-turn-escort-"));
  await writeFile(join(agentDir, "BOOT.md"), "# I am Phantom", "utf8");
  memory = await openMemoryStore(":memory:");
});
afterEach(async () => {
  await memory.close();
  await rm(agentDir, { recursive: true, force: true });
});

const SETTINGS: EscortSettings = {
  baseUrl: "https://jev.test/api/v1",
  model: "typesafe/jev-1.13",
  keyEnv: "TEST_JEV_KEY",
  timeoutMs: 500,
  threshold: 70,
};

/** A harness that records each request; `escort` toggles supportsEscort. */
function harness(id: string, escort: boolean) {
  const reqs: HarnessRequest[] = [];
  const h: Harness = {
    id,
    ...(escort ? { supportsEscort: true } : {}),
    available: async () => true,
    async *invoke(req: HarnessRequest): AsyncGenerator<HarnessChunk> {
      reqs.push(req);
      yield { type: "text", text: `from ${id}` };
      yield { type: "done", finalText: `from ${id}` };
    },
  };
  return { h, reqs };
}

async function run(opts: {
  harnesses: Harness[];
  verdict: ScreenVerdict;
  trusted?: boolean;
}) {
  let retrieved = 0;
  const chunks: HarnessChunk[] = [];
  for await (const c of runTurn({
    persona: "phantom",
    conversation: "cli:default",
    agentDir,
    workingDir: agentDir,
    memory,
    idleTimeoutMs: 1_000,
    hardTimeoutMs: 5_000,
    userMessage: "please file the invoice",
    harnesses: opts.harnesses,
    ...(opts.trusted ? { trusted: true } : {}),
    screen: async () => opts.verdict,
    retrieve: async () => {
      retrieved++;
      return undefined;
    },
  } as Parameters<typeof runTurn>[0])) {
    chunks.push(c);
  }
  return { chunks, retrieved };
}

const PASS_ESCORTED: ScreenVerdict = { action: "pass", score: 5, reason: "ok", escort: SETTINGS };
const PASS_PLAIN: ScreenVerdict = { action: "pass", score: 5, reason: "ok" };

describe("runTurn + escort", () => {
  test("a passed, escorted turn hands the harness the escort context with the task", async () => {
    const a = harness("claude", true);
    await run({ harnesses: [a.h], verdict: PASS_ESCORTED });
    expect(a.reqs).toHaveLength(1);
    expect(a.reqs[0]!.escort).toEqual({ ...SETTINGS, task: "please file the invoice" });
  });

  test("harnesses that cannot enforce the escort are left out of the chain", async () => {
    const codex = harness("codex", false);
    const native = harness("native", true);
    const { chunks } = await run({ harnesses: [codex.h, native.h], verdict: PASS_ESCORTED });
    expect(codex.reqs).toHaveLength(0);
    expect(native.reqs).toHaveLength(1);
    expect(chunks.at(-1)).toMatchObject({ type: "done", finalText: "from native" });
  });

  test("no harness can enforce it ⇒ held: nothing runs, nothing is retrieved", async () => {
    const codex = harness("codex", false);
    const { chunks, retrieved } = await run({ harnesses: [codex.h], verdict: PASS_ESCORTED });
    expect(codex.reqs).toHaveLength(0);
    expect(retrieved).toBe(0);
    expect(chunks.at(-1)).toMatchObject({ type: "done", meta: { screenedHold: true } });
  });

  test("no decision model (no escort settings) ⇒ today's behaviour: full chain, no escort", async () => {
    const codex = harness("codex", false);
    const { chunks } = await run({ harnesses: [codex.h], verdict: PASS_PLAIN });
    expect(codex.reqs).toHaveLength(1);
    expect(codex.reqs[0]!.escort).toBeUndefined();
    expect(chunks.at(-1)).toMatchObject({ type: "done", finalText: "from codex" });
  });

  test("a trusted turn is never escorted, even if a screener would offer it", async () => {
    const codex = harness("codex", false);
    await run({ harnesses: [codex.h], verdict: PASS_ESCORTED, trusted: true });
    expect(codex.reqs).toHaveLength(1);
    expect(codex.reqs[0]!.escort).toBeUndefined();
  });
});
