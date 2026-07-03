/**
 * ACP `tool_call` builder — structured detail wiring (issue #231).
 *
 * Proves the `kind` / `locations` / `content` fields land on the wire only
 * when present, so pre-#231 (title-only) behaviour and clients that ignore the
 * new fields are unaffected.
 */
import { describe, expect, test } from "bun:test";
import {
  toolCallUpdate,
  type ToolCallUpdate
} from "../src/connectors/acp/protocol.ts";

function update(req: ReturnType<typeof toolCallUpdate>): ToolCallUpdate {
  const params = req.params as { sessionId: string; update: ToolCallUpdate };
  return params.update;
}

describe("toolCallUpdate (#231)", () => {
  test("title-only call omits the new fields entirely (back-compat)", () => {
    const u = update(toolCallUpdate("s1", "tool_1", "Bash: git status"));
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

  test("emits kind + clickable locations when the detail carries them", () => {
    const u = update(
      toolCallUpdate("s1", "tool_2", "Read: src/foo.ts", "in_progress", {
        kind: "read",
        locations: [{ path: "src/foo.ts" }]
      })
    );
    expect(u.kind).toBe("read");
    expect(u.locations).toEqual([{ path: "src/foo.ts" }]);
    expect("content" in u).toBe(false);
  });

  test("omits an empty locations array so the field never renders blank", () => {
    const u = update(
      toolCallUpdate("s1", "tool_3", "Bash: ls", "in_progress", {
        kind: "execute",
        locations: []
      })
    );
    expect(u.kind).toBe("execute");
    expect("locations" in u).toBe(false);
  });

  test("wraps a content preview as an ACP content block when present", () => {
    const u = update(
      toolCallUpdate("s1", "tool_4", "Read: a.ts", "in_progress", {
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
      toolCallUpdate("s1", "tool_5", "Bash: ls", "completed")
    );
    expect(u.status).toBe("completed");
  });
});
