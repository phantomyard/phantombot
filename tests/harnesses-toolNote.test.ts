import { describe, expect, test } from "bun:test";
import {
  buildToolCall,
  buildToolNote,
  MAX_TOOL_NOTE_LEN
} from "../src/harnesses/toolNote.ts";

describe("buildToolNote", () => {
  test("shell command → '<Name>: <command>'", () => {
    expect(buildToolNote("Bash", { command: "git status" })).toBe(
      "Bash: git status",
    );
  });

  test("file tools surface the path", () => {
    expect(buildToolNote("Read", { file_path: "src/foo.ts" })).toBe(
      "Read: src/foo.ts",
    );
    expect(buildToolNote("Write", { path: "/tmp/out.txt" })).toBe(
      "Write: /tmp/out.txt",
    );
    expect(
      buildToolNote("read_file", { absolute_path: "/etc/hosts" }),
    ).toBe("read_file: /etc/hosts");
  });

  test("search tools surface the pattern/query", () => {
    expect(buildToolNote("Grep", { pattern: "TODO" })).toBe("Grep: TODO");
    expect(buildToolNote("search", { query: "vector index" })).toBe(
      "search: vector index",
    );
  });

  test("sub-agent delegation combines subagent + prompt", () => {
    expect(
      buildToolNote("Agent", {
        subagent_type: "Explore",
        prompt: "find the retrieval code",
      }),
    ).toBe("Agent: Explore — find the retrieval code");
  });

  test("sub-agent with only a description still shows it", () => {
    expect(buildToolNote("Task", { description: "audit deps" })).toBe(
      "Task: audit deps",
    );
  });

  test("codex shell command-array is joined", () => {
    // codex passes the whole item; command can be an argv array
    expect(
      buildToolNote("shell", {
        type: "tool_call",
        name: "shell",
        command: ["git", "log", "--oneline"],
      }),
    ).toBe("shell: git log --oneline");
  });

  test("web tools surface the url", () => {
    expect(
      buildToolNote("WebFetch", { url: "https://example.com/x" }),
    ).toBe("WebFetch: https://example.com/x");
  });

  test("multi-line / whitespace-heavy commands collapse to one line", () => {
    expect(
      buildToolNote("Bash", { command: "for f in *; do\n  echo $f\ndone" }),
    ).toBe("Bash: for f in *; do echo $f done");
  });

  test("over-long titles are truncated with an ellipsis at the cap", () => {
    const long = "x".repeat(200);
    const note = buildToolNote("Bash", { command: long });
    expect(note.length).toBe(MAX_TOOL_NOTE_LEN);
    expect(note.startsWith("Bash: ")).toBe(true);
    expect(note.endsWith("…")).toBe(true);
  });

  // --- backward-compatibility (legacy label preserved) ---

  test("no usable detail → legacy 'tool: <name>'", () => {
    expect(buildToolNote("Bash", {})).toBe("tool: Bash");
    expect(buildToolNote("Read")).toBe("tool: Read");
    expect(buildToolNote("run_shell_command", { foo: 1 })).toBe(
      "tool: run_shell_command",
    );
  });

  test("no name at all → legacy bare 'tool'", () => {
    expect(buildToolNote(undefined)).toBe("tool");
    expect(buildToolNote("")).toBe("tool");
    expect(buildToolNote(undefined, { command: "git status" })).toBe("tool");
  });

  test("never throws on hostile input", () => {
    expect(() => buildToolNote("X", null)).not.toThrow();
    expect(() => buildToolNote("X", 42)).not.toThrow();
    expect(() => buildToolNote("X", "a string")).not.toThrow();
    expect(() => buildToolNote("X", [1, 2, 3])).not.toThrow();
    // unusable input degrades to the legacy label
    expect(buildToolNote("X", "a string")).toBe("tool: X");
  });
});

describe("buildToolCall (#231)", () => {
  test("title is byte-identical to buildToolNote", () => {
    const cases: [string | undefined, unknown][] = [
      ["Bash", { command: "git status" }],
      ["Read", { file_path: "src/foo.ts" }],
      ["run_shell_command", { foo: 1 }],
      [undefined, { command: "x" }],
      ["", undefined]
    ];
    for (const [name, input] of cases) {
      expect(buildToolCall(name, input).title).toBe(buildToolNote(name, input));
    }
  });

  test("kind is keyed on the tool NAME, across per-harness spellings", () => {
    expect(buildToolCall("Read", {}).kind).toBe("read");
    expect(buildToolCall("read_file", {}).kind).toBe("read");
    expect(buildToolCall("Edit", {}).kind).toBe("edit");
    expect(buildToolCall("write_file", {}).kind).toBe("edit");
    expect(buildToolCall("apply_patch", {}).kind).toBe("edit");
    expect(buildToolCall("Bash", {}).kind).toBe("execute");
    expect(buildToolCall("run_shell_command", {}).kind).toBe("execute");
    expect(buildToolCall("Grep", {}).kind).toBe("search");
    expect(buildToolCall("glob", {}).kind).toBe("search");
    expect(buildToolCall("WebFetch", {}).kind).toBe("fetch");
    expect(buildToolCall("Task", {}).kind).toBe("other");
  });

  test("kind normalises spaces/hyphens/case before lookup", () => {
    expect(buildToolCall("Run-Shell-Command", {}).kind).toBe("execute");
    expect(buildToolCall("READ FILE", {}).kind).toBe("read");
  });

  test("kind falls back to input field names for unknown tools", () => {
    expect(buildToolCall("mystery", { command: "ls" }).kind).toBe("execute");
    expect(buildToolCall("mystery", { pattern: "foo" }).kind).toBe("search");
    expect(buildToolCall("mystery", { url: "https://x" }).kind).toBe("fetch");
    expect(buildToolCall("mystery", { file_path: "a.ts" }).kind).toBe("read");
    expect(buildToolCall("mystery", {}).kind).toBe("other");
    expect(buildToolCall(undefined, undefined).kind).toBe("other");
  });

  test("locations are extracted from path fields, deduped, clickable", () => {
    expect(buildToolCall("Read", { file_path: "src/foo.ts" }).locations).toEqual(
      [{ path: "src/foo.ts" }]
    );
    expect(buildToolCall("Edit", { path: "a.ts" }).locations).toEqual([
      { path: "a.ts" }
    ]);
    // Non-file tools contribute no locations.
    expect(buildToolCall("Bash", { command: "git status" }).locations).toEqual(
      []
    );
    expect(buildToolCall("Grep", { pattern: "foo" }).locations).toEqual([]);
  });

  test("locations dedupe repeated paths and skip empties", () => {
    // file_path and path carry the same value → one location.
    expect(
      buildToolCall("Edit", { file_path: "dup.ts", path: "dup.ts" }).locations
    ).toEqual([{ path: "dup.ts" }]);
    expect(buildToolCall("Read", { file_path: "   " }).locations).toEqual([]);
  });

  test("content is left unpopulated pending redaction", () => {
    expect(buildToolCall("Bash", { command: "git status" }).content).toBeUndefined();
  });

  test("never throws on hostile input; degrades cleanly", () => {
    for (const bad of [null, 42, "str", [1, 2, 3]]) {
      expect(() => buildToolCall("X", bad)).not.toThrow();
      const call = buildToolCall("X", bad);
      expect(call.locations).toEqual([]);
      expect(typeof call.kind).toBe("string");
    }
  });
});
