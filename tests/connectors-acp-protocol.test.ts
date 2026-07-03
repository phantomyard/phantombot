/**
 * ACP `tool_call` builder — structured detail wiring (issue #231).
 *
 * Proves the `kind` / `locations` / `content` fields land on the wire only
 * when present, so pre-#231 (title-only) behaviour and clients that ignore the
 * new fields are unaffected. Also proves `locations` are resolved to ABSOLUTE
 * paths against the session cwd before hitting the wire, as the ACP
 * `ToolCallLocation.path` spec requires (review follow-up on #231).
 */
import { describe, expect, test } from "bun:test";
import {
  toAbsoluteLocations,
  toolCallUpdate,
  type ToolCallUpdate
} from "../src/connectors/acp/protocol.ts";

const CWD = "/home/dev/workspace";

function update(req: ReturnType<typeof toolCallUpdate>): ToolCallUpdate {
  const params = req.params as { sessionId: string; update: ToolCallUpdate };
  return params.update;
}

describe("toolCallUpdate (#231)", () => {
  test("title-only call omits the new fields entirely (back-compat)", () => {
    const u = update(toolCallUpdate("s1", "tool_1", "Bash: git status", CWD));
    expect(u).toEqual({
      sessionUpdate: "tool_call",
      toolCallId: "tool_1",
      title: "Bash: git status",
      status: "in_progress"
    });
    expect("kind" in u).toBe(false);
    expect("locations" in u).toBe(false);
    expect("content" in u).toBe(false);
  });

  test("emits kind + resolves relative locations to absolute paths", () => {
    const u = update(
      toolCallUpdate("s1", "tool_2", "Read: src/foo.ts", CWD, "in_progress", {
        kind: "read",
        locations: [{ path: "src/foo.ts" }]
      })
    );
    expect(u.kind).toBe("read");
    // The wire must carry an ABSOLUTE path, not the relative arg.
    expect(u.locations).toEqual([{ path: "/home/dev/workspace/src/foo.ts" }]);
    expect("content" in u).toBe(false);
  });

  test("passes an already-absolute location through untouched", () => {
    const u = update(
      toolCallUpdate("s1", "tool_2b", "Read: /etc/hosts", CWD, "in_progress", {
        kind: "read",
        locations: [{ path: "/etc/hosts", line: 3 }]
      })
    );
    expect(u.locations).toEqual([{ path: "/etc/hosts", line: 3 }]);
  });

  test("omits an empty locations array so the field never renders blank", () => {
    const u = update(
      toolCallUpdate("s1", "tool_3", "Bash: ls", CWD, "in_progress", {
        kind: "execute",
        locations: []
      })
    );
    expect(u.kind).toBe("execute");
    expect("locations" in u).toBe(false);
  });

  test("wraps a content preview as an ACP content block when present", () => {
    const u = update(
      toolCallUpdate("s1", "tool_4", "Read: a.ts", CWD, "in_progress", {
        kind: "read",
        locations: [],
        content: "preview body"
      })
    );
    expect(u.content).toEqual([
      { type: "content", content: { type: "text", text: "preview body" } }
    ]);
  });

  test("preserves an explicit non-default status", () => {
    const u = update(
      toolCallUpdate("s1", "tool_5", "Bash: ls", CWD, "completed")
    );
    expect(u.status).toBe("completed");
  });
});

describe("toAbsoluteLocations (#231 review follow-up)", () => {
  test("resolves a relative path against the session cwd", () => {
    expect(toAbsoluteLocations([{ path: "src/a.ts" }], CWD)).toEqual([
      { path: "/home/dev/workspace/src/a.ts" }
    ]);
  });

  test("normalises `..` segments while resolving", () => {
    expect(toAbsoluteLocations([{ path: "../sibling/b.ts" }], CWD)).toEqual([
      { path: "/home/dev/sibling/b.ts" }
    ]);
  });

  test("leaves an absolute path unchanged and preserves `line`", () => {
    expect(
      toAbsoluteLocations([{ path: "/abs/c.ts", line: 12 }], CWD)
    ).toEqual([{ path: "/abs/c.ts", line: 12 }]);
  });

  test("preserves `line` when resolving a relative path", () => {
    expect(toAbsoluteLocations([{ path: "d.ts", line: 5 }], CWD)).toEqual([
      { path: "/home/dev/workspace/d.ts", line: 5 }
    ]);
  });

  test("handles a mixed batch (relative + absolute) in order", () => {
    expect(
      toAbsoluteLocations(
        [{ path: "rel/e.ts" }, { path: "/abs/f.ts" }],
        CWD
      )
    ).toEqual([
      { path: "/home/dev/workspace/rel/e.ts" },
      { path: "/abs/f.ts" }
    ]);
  });

  test("returns [] for an empty batch", () => {
    expect(toAbsoluteLocations([], CWD)).toEqual([]);
  });
});
