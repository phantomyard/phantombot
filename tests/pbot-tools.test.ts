/**
 * The typed pbot_* tools (#820) against the CLI they mirror.
 *
 * Parity is the contract: a tool call runs the SAME shared action function as
 * its CLI command, so the same input must leave the same row, the same
 * capture-log row and the same search hit. Each write action is driven once
 * through the tool (persona `viatool`) and once through the CLI run function
 * (persona `viacli`) and the persisted state is compared field by field.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runMemoryCapture, runMemorySearch } from "../src/cli/memory.ts";
import { runTaskAdd } from "../src/cli/task.ts";
import { redactSecretValues, runVaultExec, runVaultGet, runVaultSet } from "../src/cli/vault.ts";
import { pbotMemory, pbotTask, pbotVault, PBOT_TOOLS, type PbotContext } from "../src/pbot/tools.ts";
import { rmrf } from "./fixtures/rmrf.ts";

let root: string;
const saved = { ...process.env };
const CONV = "telegram:4242";

class Sink {
  text = "";
  write(s: string | Uint8Array) {
    this.text += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }
}

function ctx(persona: string, extraEnv: Record<string, string> = {}): PbotContext {
  return {
    persona,
    conversation: CONV,
    env: { ...process.env, PHANTOMBOT_PERSONA: persona, PHANTOMBOT_CONVERSATION: CONV, ...extraEnv },
  };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "phantombot-pbot-"));
  const personas = join(root, "personas");
  for (const p of ["viatool", "viacli"]) {
    await mkdir(join(personas, p, "memory"), { recursive: true });
    await mkdir(join(personas, p, "kb"), { recursive: true });
  }
  await writeFile(join(root, "config.toml"), 'default_persona = "viatool"\n');
  process.env.PHANTOMBOT_CONFIG = join(root, "config.toml");
  process.env.PHANTOMBOT_PERSONAS_DIR = personas;
  process.env.PHANTOMBOT_MEMORY_DB = join(root, "memory.sqlite");
  process.env.XDG_DATA_HOME = join(root, "xdg-data");
  process.env.XDG_STATE_HOME = join(root, "xdg-state");
  delete process.env.PHANTOMBOT_PERSONA;
  delete process.env.PHANTOMBOT_CONVERSATION;
  delete process.env.PHANTOMBOT_SECURITY_SESSION;
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

afterAll(async () => {
  process.env = { ...saved };
  await rmrf(root);
});

describe("catalog shape", () => {
  test("seven capability tools, one per capability, each with an action enum", () => {
    expect(PBOT_TOOLS.map((t) => t.name)).toEqual([
      "pbot_memory",
      "pbot_vault",
      "pbot_task",
      "pbot_mcp",
      "pbot_notify",
      "pbot_browser",
      "pbot_device",
    ]);
    for (const t of PBOT_TOOLS) {
      expect(t.inputSchema.required).toContain("action");
      expect((t.inputSchema.properties.action as { enum: string[] }).enum.length).toBeGreaterThan(0);
    }
  });

  test("an unknown action is a tool error, never a throw", async () => {
    for (const t of PBOT_TOOLS) {
      const r = await t.run({ action: "definitely-not" }, ctx("viatool"));
      expect(r.isError).toBe(true);
    }
  });
});

describe("pbot_memory capture — parity with `phantombot memory capture`", () => {
  const text = "parity capture: the shared action owns the side effects";

  test("same journal row, same capture-log row, same search hit", async () => {
    const viaTool = await pbotMemory.run({ action: "capture", text, tags: ["decision", "lesson"] }, ctx("viatool"));
    expect(viaTool.isError).toBeUndefined();

    const out = new Sink();
    const code = await runMemoryCapture({ text, tags: ["decision", "lesson"], persona: "viacli", conversation: CONV, out, err: new Sink() });
    expect(code).toBe(0);

    // The tool reports exactly what the CLI prints, persona aside.
    expect(viaTool.text.replace("viatool", "X")).toBe(out.text.trimEnd().replace("viacli", "X"));

    const db = new Database(process.env.PHANTOMBOT_MEMORY_DB!, { readonly: true });
    try {
      const rows = db
        .query("SELECT persona, content, tags, source, conversation, date FROM journal_entries WHERE content = ? ORDER BY persona")
        .all(text) as Array<Record<string, string>>;
      expect(rows.length).toBe(2);
      const [cli, tool] = rows; // ordered: viacli, viatool
      expect({ ...tool, persona: "" }).toEqual({ ...cli, persona: "" });
      expect(tool!.conversation).toBe(CONV);

      const logs = db
        .query("SELECT persona, conversation, tags FROM capture_log ORDER BY persona")
        .all() as Array<Record<string, string>>;
      const cliLog = logs.find((l) => l.persona === "viacli");
      const toolLog = logs.find((l) => l.persona === "viatool");
      expect(toolLog).toBeDefined();
      expect({ ...toolLog, persona: "" }).toEqual({ ...cliLog, persona: "" });
    } finally {
      db.close();
    }

    // Indexed on write through both routes: searchable at once.
    const viaToolSearch = await pbotMemory.run({ action: "search", query: "parity capture shared action" }, ctx("viatool"));
    const cliOut = new Sink();
    await runMemorySearch({ query: "parity capture shared action", persona: "viacli", out: cliOut, err: new Sink() });
    const toolHits = JSON.parse(viaToolSearch.text).results.map((r: { path: string }) => r.path);
    const cliHits = JSON.parse(cliOut.text).results.map((r: { path: string }) => r.path);
    expect(toolHits.length).toBeGreaterThan(0);
    expect(toolHits).toEqual(cliHits);
  });

  test("a capture with no tag is refused, like the CLI", async () => {
    const r = await pbotMemory.run({ action: "capture", text: "untagged" }, ctx("viatool"));
    expect(r.isError).toBe(true);
    expect(r.text).toContain("--tag");
  });
});

describe("pbot_vault — parity with `phantombot vault`", () => {
  test("set: same stored value, same name-only acknowledgement", async () => {
    const viaTool = await pbotVault.run({ action: "set", name: "PARITY_KEY", value: "v-123" }, ctx("viatool"));
    const out = new Sink();
    await runVaultSet({ name: "PARITY_KEY", value: "v-123", persona: "viacli", out, err: new Sink() });
    expect(viaTool.text).toBe(out.text.trimEnd());
    expect(viaTool.text).not.toContain("v-123");
    for (const p of ["viatool", "viacli"]) {
      const g = new Sink();
      await runVaultGet({ name: "PARITY_KEY", persona: p, out: g, err: new Sink() });
      expect(g.text.trim()).toBe("v-123");
    }
  });

  test("list returns names only", async () => {
    const r = await pbotVault.run({ action: "list" }, ctx("viatool"));
    expect(r.text).toContain("PARITY_KEY");
    expect(r.text).not.toContain("v-123");
  });
});

describe("pbot_vault exec — scoped secrets", () => {
  test("short secrets (1-3 chars) are redacted too (PR #821 review)", () => {
    expect(redactSecretValues("token=abc", new Map([["SHORT_TOKEN", "abc"]]))).toBe("token=«SHORT_TOKEN»");
    expect(redactSecretValues("pin=42;", new Map([["PIN", "42"]]))).toBe("pin=«PIN»;");
    expect(redactSecretValues("k=Z", new Map([["ONE", "Z"]]))).toBe("k=«ONE»");
    expect(redactSecretValues("unchanged", new Map([["EMPTY", ""]]))).toBe("unchanged");
  });

  beforeAll(async () => {
    for (const [n, v] of [
      ["EXEC_WANTED", "wanted-secret-value"],
      ["EXEC_OTHER", "other-secret-value"],
    ]) {
      await runVaultSet({ name: n!, value: v!, persona: "viatool", out: new Sink(), err: new Sink() });
    }
  });

  test("the command sees ONLY the named secret; its value never comes back", async () => {
    // Simulate a daemon-spawned turn: every vault secret already in the env.
    const c = ctx("viatool", { EXEC_WANTED: "wanted-secret-value", EXEC_OTHER: "other-secret-value" });
    const r = await pbotVault.run(
      {
        action: "exec",
        secrets: ["EXEC_WANTED"],
        command: 'echo "wanted=$EXEC_WANTED"; echo "other=${EXEC_OTHER:-absent}"; env | grep -c EXEC_OTHER || true',
      },
      c,
    );
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain("wanted=«EXEC_WANTED»");
    expect(r.text).toContain("other=absent");
    expect(r.text).not.toContain("wanted-secret-value");
    expect(r.text).not.toContain("other-secret-value");
  });

  test("the secret really is in the command's env (length check, value redacted)", async () => {
    const r = await pbotVault.run(
      { action: "exec", secrets: ["EXEC_WANTED"], command: 'printf "%s" "$EXEC_WANTED" | wc -c' },
      ctx("viatool"),
    );
    expect(r.text.trim()).toBe(String("wanted-secret-value".length));
  });

  test("an unknown secret name fails before anything runs", async () => {
    const r = await pbotVault.run({ action: "exec", secrets: ["NOPE_NOT_SET"], command: "echo ran" }, ctx("viatool"));
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("ran");
  });

  test("a failing command is a tool error carrying its exit status", async () => {
    const r = await pbotVault.run({ action: "exec", secrets: [], command: "echo boom >&2; exit 3" }, ctx("viatool"));
    expect(r.isError).toBe(true);
    expect(r.text).toContain("boom");
  });

  test("parity: the tool and `phantombot vault exec` produce the same output", async () => {
    const command = 'echo "k=$EXEC_WANTED"; echo "o=${EXEC_OTHER:-absent}"';
    const viaTool = await pbotVault.run({ action: "exec", secrets: ["EXEC_WANTED"], command }, ctx("viatool"));
    const out = new Sink();
    const code = await runVaultExec({
      secrets: ["EXEC_WANTED"],
      command,
      persona: "viatool",
      env: { ...process.env, EXEC_OTHER: "other-secret-value" },
      out,
      err: new Sink(),
    });
    expect(code).toBe(0);
    expect(viaTool.text).toBe(out.text.trimEnd());
  });
});

describe("vault exec timeout kills the whole command tree", () => {
  test.skipIf(process.platform === "win32")(
    "a backgrounded descendant dies with the cap: prompt return, no late side effect",
    async () => {
      const marker = join(root, "vault-exec-late-marker");
      const started = Date.now();
      const err = new Sink();
      const code = await runVaultExec({
        secrets: [],
        command: `bash -c 'sleep 3; printf survived > "${marker}"' & wait`,
        persona: "viatool",
        timeoutS: 1,
        out: new Sink(),
        err,
      });
      const elapsed = Date.now() - started;
      expect(code).toBe(124);
      expect(err.text).toContain("killed after 1s");
      // Before the fix the outer bash died but the descendant held the pipes
      // open, so this returned only after ~3s and then wrote the marker.
      expect(elapsed).toBeLessThan(2500);
      await new Promise((r) => setTimeout(r, 3000));
      expect(await Bun.file(marker).exists()).toBe(false);
    },
    15_000,
  );
});

describe("pbot_task add — parity with `phantombot task add`", () => {
  test("same schedule row through both routes", async () => {
    const viaTool = await pbotTask.run(
      { action: "add", prompt: "check the thing", description: "parity task", every: "1h", count: 3 },
      ctx("viatool"),
    );
    expect(viaTool.isError).toBeUndefined();
    expect(viaTool.text).toMatch(/task \d+ scheduled/);
    const out = new Sink();
    const code = await runTaskAdd({
      prompt: "check the thing",
      description: "parity task",
      every: "1h",
      count: 3,
      persona: "viacli",
      out,
      err: new Sink(),
    });
    expect(code).toBe(0);
    const db = new Database(process.env.PHANTOMBOT_MEMORY_DB!, { readonly: true });
    try {
      const rows = db
        .query("SELECT * FROM tasks WHERE description = 'parity task' ORDER BY persona")
        .all() as Array<Record<string, unknown>>;
      expect(rows.length).toBe(2);
      const strip = (r: Record<string, unknown>) => {
        const { id: _id, persona: _p, created_at: _c, next_run_at: _n, next_review_at: _r, ...rest } = r;
        return rest;
      };
      expect(strip(rows[1]!)).toEqual(strip(rows[0]!));
    } finally {
      db.close();
    }
  });
});
