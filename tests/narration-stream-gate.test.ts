import { describe, expect, test } from "bun:test";

import type { HarnessChunk } from "../src/harnesses/types.ts";
import {
  createNarrationStreamGate,
  gateNarrationStream,
} from "../src/lib/narrationStreamGate.ts";

/** Feed a chunk script through the gate and collect what it emits. */
function run(userMessage: string, chunks: HarnessChunk[]): HarnessChunk[] {
  const gate = createNarrationStreamGate(userMessage);
  const out: HarnessChunk[] = [];
  for (const c of chunks) out.push(...gate.push(c));
  return out;
}

const text = (t: string): HarnessChunk => ({ type: "text", text: t });
const progress = (note = "Bash"): HarnessChunk => ({ type: "progress", note });
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
});
