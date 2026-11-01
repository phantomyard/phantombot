/**
 * Tests for the media → caption coalescer (receive side).
 *
 * The defect: a client that publishes an attachment and the typed text as TWO
 * events makes the phantom answer the attachment before it has read the
 * question. These tests pin the coalescing rules — one turn when the text
 * arrives in the window, unchanged behaviour when it does not.
 */

import { describe, expect, test } from "bun:test";

import type { ChannelMessage } from "../src/channels/core/types.ts";
import {
  DEFAULT_MEDIA_CAPTION_WINDOW_MS,
  isBareAttachment,
  MediaCaptionCoalescer,
} from "../src/channels/phantomchat/mediaCaptionCoalescer.ts";

const SENDER = "a".repeat(64);
const OTHER_SENDER = "b".repeat(64);
const DM = "dm-conversation";

function msg(over: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    conversationId: DM,
    senderId: SENDER,
    text: "",
    ...over,
  };
}

function attachment(over: Partial<ChannelMessage> = {}): ChannelMessage {
  return msg({
    media: {
      kind: "image",
      url: "https://blossom.example/abc",
      sha256: "abc123",
      keyHex: "00".repeat(32),
      ivHex: "11".repeat(12),
      mimeType: "image/png",
    },
    ...over,
  });
}

function text(body: string, over: Partial<ChannelMessage> = {}): ChannelMessage {
  return msg({ text: body, ...over });
}

/** A coalescer wired to a plain array, with a short window for the tests. */
function makeCoalescer(windowMs = 30) {
  const out: ChannelMessage[] = [];
  const coalescer = new MediaCaptionCoalescer({
    windowMs,
    dispatch: (m) => out.push(m),
  });
  return { coalescer, out };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("isBareAttachment", () => {
  test("an attachment with no text is bare", () => {
    expect(isBareAttachment(attachment())).toBe(true);
  });

  test("an attachment with a caption is not bare", () => {
    expect(isBareAttachment(attachment({ text: "look at this" }))).toBe(false);
  });

  test("a voice note is never bare (its transcript IS the message)", () => {
    const voice = msg({
      media: {
        kind: "voice",
        url: "https://blossom.example/v",
        sha256: "v",
        keyHex: "00".repeat(32),
        ivHex: "11".repeat(12),
        mimeType: "audio/ogg",
      },
    });
    expect(isBareAttachment(voice)).toBe(false);
  });

  test("a reaction is not an attachment", () => {
    const reaction = msg({
      reaction: { conversationId: DM, targetMessageId: "m1", emoji: "👍", senderId: SENDER, groupId: undefined } as never,
      media: attachment().media,
    });
    expect(isBareAttachment(reaction)).toBe(false);
  });

  test("plain text is not an attachment", () => {
    expect(isBareAttachment(text("hello"))).toBe(false);
  });
});

describe("media caption coalescing", () => {
  test("text inside the window merges into ONE message carrying both", () => {
    const { coalescer, out } = makeCoalescer();
    coalescer.accept(attachment());
    expect(out).toHaveLength(0); // held, not dispatched
    expect(coalescer.heldConversations).toBe(1);

    coalescer.accept(text("what is this?"));

    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("what is this?");
    expect(out[0]!.media?.sha256).toBe("abc123");
    expect(coalescer.heldConversations).toBe(0);
  });

  test("no text in the window dispatches the attachment alone", async () => {
    const { coalescer, out } = makeCoalescer(20);
    coalescer.accept(attachment());
    expect(out).toHaveLength(0);

    await sleep(60);

    expect(out).toHaveLength(1);
    expect(out[0]!.media?.sha256).toBe("abc123");
    expect(out[0]!.text).toBe("");
    expect(coalescer.heldConversations).toBe(0);
  });

  test("text from a DIFFERENT sender does not merge — the attachment is flushed first", () => {
    const { coalescer, out } = makeCoalescer();
    coalescer.accept(attachment());
    coalescer.accept(text("unrelated", { senderId: OTHER_SENDER }));

    expect(out).toHaveLength(2);
    expect(out[0]!.media?.sha256).toBe("abc123");
    expect(out[0]!.text).toBe("");
    expect(out[1]!.text).toBe("unrelated");
    expect(out[1]!.media).toBeUndefined();
  });

  test("a voice note is dispatched immediately and does not wait", () => {
    const { coalescer, out } = makeCoalescer();
    coalescer.accept(
      msg({
        media: {
          kind: "voice",
          url: "https://blossom.example/v",
          sha256: "v",
          keyHex: "00".repeat(32),
          ivHex: "11".repeat(12),
          mimeType: "audio/ogg",
        },
      }),
    );
    expect(out).toHaveLength(1);
    expect(coalescer.heldConversations).toBe(0);
  });

  test("an attachment that already carries a caption is not held", () => {
    const { coalescer, out } = makeCoalescer();
    coalescer.accept(attachment({ text: "already captioned" }));
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("already captioned");
  });

  test("a burst: the first file takes the caption, the rest keep their own turns", () => {
    const { coalescer, out } = makeCoalescer();
    coalescer.accept(attachment({ media: { ...attachment().media!, sha256: "first" } }));
    coalescer.accept(attachment({ media: { ...attachment().media!, sha256: "second" } }));
    expect(out).toHaveLength(0);

    coalescer.accept(text("compare these"));

    expect(out).toHaveLength(2);
    expect(out[0]!.text).toBe("compare these");
    expect(out[0]!.media?.sha256).toBe("first");
    expect(out[1]!.text).toBe("");
    expect(out[1]!.media?.sha256).toBe("second");
  });

  test("a burst from a different sender flushes the first hold and starts a new one", () => {
    const { coalescer, out } = makeCoalescer();
    coalescer.accept(attachment({ media: { ...attachment().media!, sha256: "mine" } }));
    coalescer.accept(
      attachment({
        senderId: OTHER_SENDER,
        media: { ...attachment().media!, sha256: "theirs" },
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.media?.sha256).toBe("mine");
    expect(coalescer.heldConversations).toBe(1);

    coalescer.accept(text("mine, really"));
    expect(coalescer.heldConversations).toBe(0);
    // The text belongs to SENDER, so it does not absorb OTHER_SENDER's file.
    expect(out).toHaveLength(3);
    expect(out[1]!.media?.sha256).toBe("theirs");
    expect(out[2]!.text).toBe("mine, really");
  });

  test("two conversations never merge into each other", () => {
    const { coalescer, out } = makeCoalescer();
    coalescer.accept(attachment({ conversationId: "group:1" }));
    coalescer.accept(text("dm question", { conversationId: DM }));

    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("dm question");
    expect(out[0]!.media).toBeUndefined();
    expect(coalescer.heldConversations).toBe(1); // the group file still waits
  });

  test("flushAll dispatches whatever is still held", () => {
    const { coalescer, out } = makeCoalescer(10_000);
    coalescer.accept(attachment());
    coalescer.accept(attachment({ conversationId: "group:1" }));
    expect(out).toHaveLength(0);

    coalescer.flushAll();

    expect(out).toHaveLength(2);
    expect(coalescer.heldConversations).toBe(0);
  });

  test("flushAll is a no-op on an empty coalescer", () => {
    const { coalescer, out } = makeCoalescer();
    coalescer.flushAll();
    expect(out).toHaveLength(0);
  });

  test("a reaction passes straight through and does not end a hold", () => {
    const { coalescer, out } = makeCoalescer();
    coalescer.accept(attachment());
    coalescer.accept(
      msg({
        reaction: {
          conversationId: DM,
          targetMessageId: "m1",
          emoji: "👍",
          senderId: SENDER,
          groupId: undefined,
        } as never,
      }),
    );

    expect(out).toHaveLength(1);
    expect(out[0]!.reaction).toBeDefined();
    expect(coalescer.heldConversations).toBe(1);
  });

  test("canCarryCaption=false flushes the attachment and passes the text through", () => {
    const out: ChannelMessage[] = [];
    const coalescer = new MediaCaptionCoalescer({
      windowMs: 30,
      dispatch: (m) => out.push(m),
      canCarryCaption: (m) => !m.text.trim().startsWith("/"),
    });

    coalescer.accept(attachment());
    coalescer.accept(text("/stop"));

    expect(out).toHaveLength(2);
    expect(out[0]!.media?.sha256).toBe("abc123");
    expect(out[0]!.text).toBe("");
    expect(out[1]!.text).toBe("/stop");
  });

  test("plain text with nothing held is dispatched immediately", () => {
    const { coalescer, out } = makeCoalescer();
    coalescer.accept(text("just talking"));
    expect(out).toHaveLength(1);
  });

  test("the default window is the documented 2s", () => {
    expect(DEFAULT_MEDIA_CAPTION_WINDOW_MS).toBe(2_000);
  });

  test("the window is measured from the FIRST attachment, not the last", async () => {
    const { coalescer, out } = makeCoalescer(40);
    coalescer.accept(attachment());
    await sleep(25);
    coalescer.accept(attachment());
    await sleep(40);
    // 65ms after the first arrival: both are out, the burst did not extend it.
    expect(out).toHaveLength(2);
    expect(coalescer.heldConversations).toBe(0);
  });
});
