import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HarnessChunk } from "../src/harnesses/types.ts";
import {
  createNarrationStreamGate,
  gateNarrationStream,
} from "../src/lib/narrationStreamGate.ts";
import { readCounters } from "../src/lib/persistedCounters.ts";

/** Feed a chunk script through the gate and collect what it emits. */
function run(userMessage: string, chunks: HarnessChunk[]): HarnessChunk[] {
  const gate = createNarrationStreamGate(userMessage);
  const out: HarnessChunk[] = [];
  for (const c of chunks) out.push(...gate.push(c));
  return out;
}

const text = (t: string): HarnessChunk => ({ type: "text", text: t });
/**
 * A tool-call boundary. Real harnesses always attach `tool` to a tool call
 * (claude.ts/codex.ts/pi.ts all build it via buildToolCall); a progress chunk
 * WITHOUT one is raw stdout liveness, which is a separate case tested below.
 */
const progress = (name = "Bash"): HarnessChunk => ({
  type: "progress",
  note: `tool: ${name}`,
  tool: { title: `tool: ${name}`, name, kind: "other", locations: [] },
});
const done = (finalText: string): HarnessChunk => ({ type: "done", finalText });

/** All emitted text, concatenated — what the surface actually renders. */
const rendered = (out: HarnessChunk[]): string =>
  out
    .filter((c): c is Extract<HarnessChunk, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("");

const finalOf = (out: HarnessChunk[]): string => {
  const d = out.find((c) => c.type === "done");
  return d && d.type === "done" ? d.finalText : "";
};

const EN = "Can you check the energy contract note for me?";

describe("narration stream gate (#580) — the leak it exists to stop", () => {
  // Real leaked lines, pulled from the stored turns that produced the #580
  // evidence: an English prompt, a correct English body, Spanish narration.
  test("drops a wrong-language narration line before a tool call", () => {
    const out = run(EN, [
      text("Miro la nota del contrato de energía."),
      progress(),
      text("The note says the Tibber supply starts on 20-09."),
      done("Miro la nota del contrato de energía.\n\nThe note says the Tibber supply starts on 20-09."),
    ]);
    expect(rendered(out)).toBe("The note says the Tibber supply starts on 20-09.");
    expect(finalOf(out)).toBe("The note says the Tibber supply starts on 20-09.");
  });

  test("the drop also leaves finalText, so history and a re-send stay clean", () => {
    const out = run(EN, [
      text("Buscando la nota del contrato de energía ahora."),
      progress(),
      done("Buscando la nota del contrato de energía ahora.\nThe totals are in the file."),
    ]);
    expect(finalOf(out)).not.toContain("Buscando");
  });

  test("narration in the user's own language is passed straight through", () => {
    const out = run(EN, [
      text("Checking the energy note now."),
      progress(),
      text("Found it."),
      done("Checking the energy note now.\nFound it."),
    ]);
    expect(rendered(out)).toBe("Checking the energy note now.Found it.");
  });

  test("drops only the offending line of a multi-line narration burst", () => {
    const out = run(EN, [
      text("Checking the energy note now\n"),
      text("Buscando la nota del contrato de energía\n"),
      text("Pulling the totals out of that file"),
      progress(),
      done("x"),
    ]);
    expect(rendered(out)).toContain("Checking the energy note now");
    expect(rendered(out)).toContain("Pulling the totals out of that file");
    expect(rendered(out)).not.toContain("Buscando");
  });
});

describe("narration stream gate — the body is never gated", () => {
  test("wrong-language text with no tool call after it is released verbatim", () => {
    // The user asked in English; the answer legitimately quotes Spanish. No
    // tool boundary follows, so it was the reply body — it must survive.
    const body = "The supplier wrote: «Su contrato de energía comienza el 20 de septiembre».";
    const out = run(EN, [text(body), done(body)]);
    expect(rendered(out)).toBe(body);
    expect(finalOf(out)).toBe(body);
  });

  test("a held line is released, in order, when the turn ends without a tool call", () => {
    const out = run(EN, [
      text("Su contrato empieza el 20 de septiembre.\n"),
      text("That is the date on the signed order."),
      done("x"),
    ]);
    expect(rendered(out)).toBe(
      "Su contrato empieza el 20 de septiembre.\nThat is the date on the signed order.",
    );
  });

  test("an error also releases the hold rather than swallowing it", () => {
    const out = run(EN, [
      text("Su contrato empieza el 20 de septiembre."),
      { type: "error", error: "harness died", recoverable: false },
    ]);
    expect(rendered(out)).toBe("Su contrato empieza el 20 de septiembre.");
    expect(out.at(-1)?.type).toBe("error");
  });

  test("a long wrong-language body is released without waiting for a boundary", () => {
    const para = "Su contrato de energía comienza el veinte de septiembre y la tarifa es dinámica. ";
    const out = run(EN, Array.from({ length: 40 }, () => text(para)));
    // No done/progress yet, but the hold cap has released it.
    expect(rendered(out).length).toBeGreaterThan(0);
  });
});

describe("narration stream gate — streaming is not stalled", () => {
  test("once a line scores as acceptable, the rest of it streams token by token", () => {
    const gate = createNarrationStreamGate(EN);
    const emit = (t: string) =>
      gate
        .push(text(t))
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("");
    // Enough function words to score English, then single tokens.
    emit("The energy note says that ");
    expect(emit("the")).toBe("the");
    expect(emit(" supply")).toBe(" supply");
  });

  test("text is flushed before the progress chunk the channels classify on", () => {
    const out = run(EN, [text("Checking the note"), progress("Bash"), done("x")]);
    const kinds = out.map((c) => c.type);
    expect(kinds.indexOf("text")).toBeLessThan(kinds.indexOf("progress"));
  });

  test("a heartbeat does not resolve or leak a hold", () => {
    const gate = createNarrationStreamGate(EN);
    gate.push(text("Buscando la nota del contrato de energía"));
    const hb = gate.push({ type: "heartbeat" });
    expect(hb.map((c) => c.type)).toEqual(["heartbeat"]);
    const after = gate.push(progress());
    expect(rendered(after)).toBe("");
  });
});

describe("narration stream gate — refuses to guess", () => {
  test("an unscoreable user message disables the gate entirely", () => {
    const out = run("ok", [
      text("Miro en el código de compactación."),
      progress(),
      done("x"),
    ]);
    expect(rendered(out)).toBe("Miro en el código de compactación.");
  });

  test("a short interstitial that scores nowhere is kept", () => {
    const out = run(EN, [text("Checking…"), progress(), done("x")]);
    expect(rendered(out)).toBe("Checking…");
  });

  test("a turn with no narration at all is untouched", () => {
    const body = "The note says the supply starts on 20-09.";
    const out = run(EN, [text(body), done(body)]);
    expect(out.map((c) => c.type)).toEqual(["text", "done"]);
    expect(rendered(out)).toBe(body);
  });
});

describe("narration stream gate — a draft is not narration (#580)", () => {
  // The reply-language rule explicitly carves this out: "text you compose FOR
  // a third party is still written in that party's language". A draft is
  // routinely followed by the tool call that sends it, so the tool-boundary
  // rule alone would eat it. Shape is what saves it.
  test("a multi-line foreign draft before a send is passed through", () => {
    const draft =
      "Beste Jeffrey,\n\nHartelijk dank voor de jaarstukken voor beide vennootschappen.\n\nMet vriendelijke groet,\nAndrew";
    const out = run("I will not approve yet, here is my reply.", [
      ...draft.split("").map((c) => text(c)),
      progress("gog gmail send"),
      done(draft),
    ]);
    expect(rendered(out)).toBe(draft);
  });

  test("a formatted foreign line before a tool call is passed through", () => {
    const line = "**Parking du Phare des Baleines** — Route du Phare des Baleines, Saint-Clément.";
    const out = run("Give me the nearest car park for Plage de la Conche.", [
      text(line),
      progress(),
      done(line),
    ]);
    expect(rendered(out)).toBe(line);
  });

  test("a quoted foreign translation before a tool call is passed through", () => {
    const line = '"La machine est en panne et elle a pris mes deux euros."';
    const out = run("How do you say the machine broke and took my two euros in French?", [
      text(line),
      progress(),
      done(line),
    ]);
    expect(rendered(out)).toBe(line);
  });

  test("a long foreign block before a tool call is passed through", () => {
    const long =
      "Su contrato de energía comienza el veinte de septiembre. " .repeat(10);
    const out = run(EN, [text(long), progress(), done(long)]);
    expect(rendered(out)).toBe(long);
  });
});

describe("the tool is the second signal (Kai + Lena, #587 review)", () => {
  // Both reviewers independently reproduced this and blocked on it. At
  // narration length, shape cannot separate a one-line Dutch DRAFT from a
  // one-line Dutch narration leak — and getting it wrong here is the worst
  // failure the gate can produce: the tool args still carry the draft, so the
  // message is sent while the principal's only copy of it is deleted.
  const DRAFT_ASK = "Send Jeffrey a short Dutch reply thanking him for the update.";
  const DRAFT = "Hartelijk dank voor de update. Ik kom morgen langs.";

  test("a short one-line foreign draft survives a sending tool", () => {
    const out = run(DRAFT_ASK, [
      text(DRAFT),
      progress("send_message"),
      done(DRAFT),
    ]);
    expect(rendered(out)).toBe(DRAFT);
    // And it must still be in finalText: a redacted finalText is a blind send.
    expect(finalOf(out)).toBe(DRAFT);
  });

  test("a multi-line draft with no paragraph break survives too", () => {
    // Lena's doc nit: the shape guard rejects any block <=400 chars with no
    // BLANK line, so an ordinary letter with single newlines was in the drop
    // zone as well.
    const letter =
      "Dank je wel voor het toesturen van de jaarstukken.\n" +
      "Ik kijk er dit weekend naar en laat het je maandag weten.";
    const out = run(DRAFT_ASK, [text(letter), progress("gmail_send_email"), done(letter)]);
    expect(rendered(out)).toBe(letter);
    expect(finalOf(out)).toBe(letter);
  });

  test("the sending-tool carve-out matches wrappers, not just bare names", () => {
    for (const name of ["mcp__gmail__send_email", "Slack-Post-Message", "notify"]) {
      const out = run(DRAFT_ASK, [text(DRAFT), progress(name), done(DRAFT)]);
      expect(rendered(out)).toBe(DRAFT);
    }
  });

  test("a tracker comment publishes too, even though it never says 'send'", () => {
    // Kai's second blocker: the token classifier covered `send`-class verbs
    // and missed the vocabulary the GitHub MCP surface actually uses, so a
    // Dutch comment drafted for an issue was dropped from the stream AND from
    // finalText while `add_issue_comment` posted it — a blind send.
    for (const name of [
      "add_issue_comment",
      "add_pull_request_review_comment",
      "discussion_comment_write",
      "mcp__github__create_issue",
    ]) {
      const out = run(DRAFT_ASK, [text(DRAFT), progress(name), done(DRAFT)]);
      expect([name, rendered(out)]).toEqual([name, DRAFT]);
      expect([name, finalOf(out)]).toEqual([name, DRAFT]);
    }
  });

  test("reading a comment is not publishing one", () => {
    // The widened vocabulary must not hand the read side an exemption: these
    // carry the same nouns and are still ordinary boundaries.
    for (const name of ["get_issue_comment", "list_discussion_comments", "write_file"]) {
      const out = run(EN, [
        text("Miro la nota del contrato de energía."),
        progress(name),
        done("Miro la nota del contrato de energía."),
      ]);
      expect([name, rendered(out)]).toEqual([name, ""]);
    }
  });

  test("but a NON-sending tool still gates the same leak", () => {
    // The carve-out must not become a blanket amnesty: the #580 leak shape in
    // front of an ordinary tool is still dropped.
    const out = run(EN, [
      text("Miro la nota del contrato de energía."),
      progress("Read"),
      done("Miro la nota del contrato de energía."),
    ]);
    expect(rendered(out)).toBe("");
  });

  test("a read/search tool is not a send, so the leak in front of it is gated", () => {
    // Kai + Lena, second round: the first carve-out matched substrings, so
    // `gmail_read_email` (mail), `slack_list_messages` (message) and
    // `postgres_query` (post) all counted as sends and released the leak.
    for (const name of [
      "gmail_read_email",
      "mcp__gmail__search_emails",
      "slack_list_messages",
      "postgres_query",
    ]) {
      const leak = "Miro la nota del contrato de energía.";
      const out = run(EN, [text(leak), progress(name), done(leak)]);
      expect([name, rendered(out)]).toEqual([name, ""]);
    }
  });

  test("raw stdout liveness is not a tool call and cannot drop anything", () => {
    // harnessRunner emits `progress` with NO `tool` for any non-JSON stdout
    // line. Treating that as a boundary let an unrelated log line delete the
    // text in front of it.
    const noisy: HarnessChunk = { type: "progress", note: "npm WARN deprecated" };
    const out = run(DRAFT_ASK, [text(DRAFT), noisy, done(DRAFT)]);
    expect(rendered(out)).toBe(DRAFT);
    expect(finalOf(out)).toBe(DRAFT);
  });
});

describe("gateNarrationStream — a quiet stream is never held open", () => {
  /** A source that yields `first`, then stalls until `release` is called. */
  function stalling(first: HarnessChunk) {
    let unblock: () => void = () => {};
    const gate = new Promise<void>((r) => (unblock = r));
    return {
      unblock: () => unblock(),
      async *source(): AsyncGenerator<HarnessChunk> {
        yield first;
        await gate;
        yield done("x");
      },
    };
  }

  test("text that has not scored is shown once the stream goes quiet", async () => {
    // This is the regression that matters: a harness writes a short sentence,
    // then thinks. Holding it until the harness speaks again would make the
    // UI look frozen — and a harness that never speaks again would swallow it.
    const s = stalling(text("working on it"));
    const seen: string[] = [];
    const it = gateNarrationStream(s.source(), "yes, apply it to all 7", 20);
    const first = await it.next();
    if (!first.done && first.value.type === "text") seen.push(first.value.text);
    s.unblock();
    for await (const c of it) if (c.type === "text") seen.push(c.text);
    expect(seen.join("")).toBe("working on it");
  });

  test("wrong-language text released on idle is released unchanged", async () => {
    const s = stalling(text("Buscando la nota del contrato de energía."));
    const it = gateNarrationStream(s.source(), EN, 20);
    const first = await it.next();
    expect(first.done).toBe(false);
    if (!first.done && first.value.type === "text") {
      expect(first.value.text).toBe("Buscando la nota del contrato de energía.");
    }
    s.unblock();
    for await (const _ of it) void _;
  });

  test("a tool call that arrives promptly still gates, idle timer or not", async () => {
    async function* src(): AsyncGenerator<HarnessChunk> {
      yield text("Buscando la nota del contrato de energía.");
      yield progress();
      yield done("Buscando la nota del contrato de energía.");
    }
    let out = "";
    for await (const c of gateNarrationStream(src(), EN, 5_000)) {
      if (c.type === "text") out += c.text;
    }
    expect(out).toBe("");
  });

  test("teardown after an idle release does not wait on the stalled source", async () => {
    // Kai + Lena, #587: an async generator serialises its queue, so
    // `it.return()` sits behind the `next()` the idle release left
    // outstanding. Awaiting it in the `finally` wedged /stop and every other
    // mid-stall abort — both reviewers reproduced it as a hang.
    let pulls = 0;
    async function* stalled(): AsyncGenerator<HarnessChunk> {
      pulls++;
      yield text("Buscando la nota del contrato de energía.");
      pulls++;
      await new Promise<void>(() => {}); // never resolves
      yield done("x");
    }
    const it = gateNarrationStream(stalled(), EN, 20);
    const first = await it.next();
    expect(first.done).toBe(false);

    const started = Date.now();
    // This is the assertion: it must RESOLVE, and promptly.
    const closed = await Promise.race([
      it.return(undefined as never).then(() => "returned" as const),
      new Promise<"hung">((r) => setTimeout(() => r("hung"), 1_000)),
    ]);
    expect(closed).toBe("returned");
    expect(Date.now() - started).toBeLessThan(500);
    expect(pulls).toBe(2);
  });
});

describe("narration stream gate — the #585 counters", () => {
  // The counter store is a real file keyed off XDG_STATE_HOME; give this
  // block its own sandbox so the assertions are self-contained. bun runs
  // the tests of a file in order, so the env swap is safe here.
  const prevState = process.env.XDG_STATE_HOME;
  let workdir = "";
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "gate-counters-"));
    process.env.XDG_STATE_HOME = workdir;
  });
  afterEach(() => {
    // beforeEach hands out a fresh sandbox per test; without this only the
    // last one got cleaned and the rest leaked in /tmp.
    if (workdir) rmSync(workdir, { recursive: true, force: true });
    workdir = "";
  });
  afterAll(() => {
    if (prevState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevState;
  });

  test("a drop is counted per (expected, actual) pair", async () => {
    run(EN, [text("Miro la nota del contrato de energía."), progress()]);
    expect(await readCounters()).toEqual({ "narration.drop.en.es": 1 });
  });

  test("multiple drops in one boundary are one batched bump", async () => {
    run(EN, [
      text("Miro la nota del contrato.\nBuscando la nota ahora."),
      progress(),
    ]);
    expect(await readCounters()).toEqual({ "narration.drop.en.es": 2 });
  });

  test("a sending-tool keep is counted, not just logged", async () => {
    const DRAFT_ASK =
      "Send Jeffrey a short Dutch reply thanking him for the update.";
    run(DRAFT_ASK, [
      text("Hartelijk dank voor de update. Ik kom morgen langs."),
      progress("send_message"),
    ]);
    expect(await readCounters()).toEqual({ "narration.sending-keep.en": 1 });
  });

  test("a shape rejection (long foreign block, non-send tool) is counted", async () => {
    const long =
      "Su contrato de energía comienza el veinte de septiembre. ".repeat(10);
    run(EN, [text(long), progress()]);
    expect(await readCounters()).toEqual({
      "narration.shape-rejection.en": 1,
    });
  });

  test("a clean turn bumps nothing", async () => {
    run(EN, [text("The supply starts on 20-09, checking now."), progress()]);
    expect(await readCounters()).toEqual({});
  });

  test("an idle release of held wrong-language text is counted", async () => {
    // A source that yields one wrong-language line, then stalls — the
    // idle race flushes the hold, and that escape hatch is counted.
    let unblock: () => void = () => {};
    const gate = new Promise<void>((r) => (unblock = r));
    async function* src(): AsyncGenerator<HarnessChunk> {
      yield text("Buscando la nota del contrato de energía.");
      await gate;
      yield { type: "done", finalText: "x" } as HarnessChunk;
    }
    const it = gateNarrationStream(src(), EN, 20);
    const first = await it.next();
    expect(first.done).toBe(false);
    unblock();
    for await (const _ of it) void _;
    expect(await readCounters()).toEqual({ "narration.idle-release.en": 1 });
  });
});
