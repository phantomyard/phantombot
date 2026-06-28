import { describe, expect, test } from "bun:test";
import { buildToolNote, MAX_TOOL_NOTE_LEN } from "../src/harnesses/toolNote.ts";

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
