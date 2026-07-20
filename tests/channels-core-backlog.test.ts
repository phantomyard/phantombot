/**
 * Unit tests for the shared per-conversation backlog epochs
 * (src/channels/core/backlog.ts) — the mechanism behind unified interrupt and
 * `/stop` semantics (GitHub #301).
 *
 * These cover the epoch bookkeeping in isolation. The channel-level behaviour
 * ("a second message drops the queued third one") is exercised end-to-end in
 * channels-telegram.test.ts.
 */

import { describe, expect, test } from "bun:test";
import {
  ConversationBacklog,
  stopNoteText,
} from "../src/channels/core/backlog.ts";

describe("ConversationBacklog", () => {
  test("a task enqueued and claimed with no flush in between runs", () => {
    const b = new ConversationBacklog();
    const epoch = b.enqueue("c1");
    expect(b.claim("c1", epoch)).toBe(true);
  });

  test("a flush supersedes every task queued before it", () => {
    const b = new ConversationBacklog();
    const first = b.enqueue("c1");
    const second = b.enqueue("c1");
    expect(b.flush("c1", "interrupt")).toBe(2);
    expect(b.claim("c1", first)).toBe(false);
    expect(b.claim("c1", second)).toBe(false);
  });

  test("a task enqueued AFTER the flush still runs — the interrupting message", () => {
    const b = new ConversationBacklog();
    b.enqueue("c1");
    b.flush("c1", "interrupt");
    const afterFlush = b.enqueue("c1");
    expect(b.claim("c1", afterFlush)).toBe(true);
  });

  test("the running task is not counted as dropped — it already claimed out", () => {
    const b = new ConversationBacklog();
    const running = b.enqueue("c1");
    b.claim("c1", running); // started executing
    const queued = b.enqueue("c1");
    // Only the one still waiting is backlog.
    expect(b.pending("c1")).toBe(1);
    expect(b.flush("c1", "stop")).toBe(1);
    expect(b.claim("c1", queued)).toBe(false);
  });

  test("flushing an idle conversation drops nothing", () => {
    const b = new ConversationBacklog();
    expect(b.flush("c1", "stop")).toBe(0);
  });

  test("a superseded task claiming late does not consume the new backlog's depth", () => {
    const b = new ConversationBacklog();
    const stale = b.enqueue("c1");
    b.flush("c1", "interrupt");
    const fresh = b.enqueue("c1");
    // The stale `.then()` finally fires and is rejected...
    expect(b.claim("c1", stale)).toBe(false);
    // ...without eating the freshly queued task's slot.
    expect(b.pending("c1")).toBe(1);
    expect(b.flush("c1", "stop")).toBe(1);
    expect(b.claim("c1", fresh)).toBe(false);
  });

  test("conversations are independent — flushing one leaves the other alone", () => {
    const b = new ConversationBacklog();
    const a = b.enqueue("c1");
    const c = b.enqueue("c2");
    expect(b.flush("c1", "interrupt")).toBe(1);
    expect(b.claim("c1", a)).toBe(false);
    expect(b.claim("c2", c)).toBe(true);
  });

  test("release forgets an idle conversation but never a busy one", () => {
    const b = new ConversationBacklog();
    const epoch = b.enqueue("c1");
    b.release("c1"); // still pending — must be a no-op
    expect(b.claim("c1", epoch)).toBe(true);
    b.release("c1");
    expect(b.pending("c1")).toBe(0);
  });
});

describe("stopNoteText", () => {
  test("tells the agent it was stopped and must not resume", () => {
    const note = stopNoteText(0);
    expect(note).toContain("/stop");
    expect(note.toLowerCase()).toContain("aborted");
    expect(note).toContain("Do not resume");
    expect(note).toContain("Await further instructions");
    // Nothing was queued, so no backlog sentence.
    expect(note).not.toContain("discarded");
  });

  test("mentions the dropped backlog when there was one, pluralized", () => {
    expect(stopNoteText(1)).toContain("1 queued message that had not started");
    expect(stopNoteText(3)).toContain("3 queued messages that had not started");
  });
});
