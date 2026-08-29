/**
 * Tests for harness health alerting.
 *
 * The behaviour under test is "when do we SPEAK", not "when do we fail
 * over" — the point of the module is that a silent failover (#284) stops
 * hiding a primary that is permanently broken.
 */

import { describe, expect, test } from "bun:test";
import {
  classifyFailure,
  DEGRADE_AFTER_FAILURES,
  HarnessAlerter,
  REALERT_MS,
} from "../src/lib/harnessAlert.ts";
import { killCauseToErrorChunk } from "../src/lib/harnessRunner.ts";

/**
 * The exact text the runner stamps for a kill cause. Derived from
 * killCauseToErrorChunk() rather than copied, so a reworded kill string
 * fails these tests instead of silently de-classifying every wedged
 * harness back to "other".
 */
function killText(cause: "timeout" | "idle" | "startup"): string {
  const chunk = killCauseToErrorChunk(cause, "pi", 300_000, 300_000, 60_000);
  if (!chunk) throw new Error(`no error chunk for kill cause '${cause}'`);
  return chunk.error;
}

function newAlerter(now: () => number = () => 0) {
  const sent: string[] = [];
  const alerter = new HarnessAlerter({
    send: (m) => {
      sent.push(m);
    },
    now,
    host: "robbie",
  });
  return { alerter, sent };
}

async function failNTimes(
  alerter: HarnessAlerter,
  n: number,
  error: string,
): Promise<void> {
  for (let i = 0; i < n; i++) {
    alerter.noteFailure("claude", error);
    await alerter.noteDegraded({ harnessId: "claude", servedBy: "pi" });
  }
}

describe("classifyFailure", () => {
  test("recognises claude's synthetic auth statuses", () => {
    expect(classifyFailure("claude api error: authentication_failed")).toBe(
      "auth",
    );
    expect(classifyFailure("claude api error: oauth_org_not_allowed")).toBe(
      "auth",
    );
    expect(classifyFailure("claude api error: billing_error")).toBe("auth");
  });

  test("recognises rate limits", () => {
    expect(classifyFailure("claude api error: rate_limit")).toBe("rate_limit");
  });

  test("http status wins over text", () => {
    expect(classifyFailure("something vague", 429)).toBe("rate_limit");
    expect(classifyFailure("something vague", 401)).toBe("auth");
  });

  // Inputs come from the runner itself, not from copies of its wording: the
  // classifier matches on that text, so a rewording there must fail here.
  test("recognises every wedged-harness kill the runner emits", () => {
    for (const cause of ["timeout", "idle", "startup"] as const) {
      expect(classifyFailure(killText(cause))).toBe("timeout");
    }
  });

  test("a real auth failure still wins over the word 'timed out'", () => {
    expect(
      classifyFailure("claude timed out after 5ms: authentication_failed"),
    ).toBe("auth");
  });

  test("anything else is 'other'", () => {
    expect(classifyFailure("claude exited with code 1")).toBe("other");
  });

  test("an empty reply is its own cause (#499)", () => {
    expect(classifyFailure("empty reply")).toBe("empty");
    expect(classifyFailure("harness produced empty reply")).toBe("empty");
    // ...but only the stamped literal — a harness error merely mentioning
    // emptiness stays `other`.
    expect(classifyFailure("claude exited with code 1: empty file")).toBe(
      "other",
    );
  });
});

describe("degraded alert", () => {
  test("stays silent below the consecutive-failure threshold", async () => {
    const { alerter, sent } = newAlerter();
    await failNTimes(
      alerter,
      DEGRADE_AFTER_FAILURES - 1,
      "claude api error: authentication_failed",
    );
    expect(sent).toEqual([]);
  });

  test("fires once when a dead credential keeps failing", async () => {
    const { alerter, sent } = newAlerter();
    await failNTimes(
      alerter,
      DEGRADE_AFTER_FAILURES + 5,
      "claude api error: authentication_failed",
    );
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("claude");
    expect(sent[0]).toContain("robbie");
    // Tells the owner the agent still works — this is not an outage.
    expect(sent[0]).toContain("pi");
  });

  test("a transient rate limit absorbed by the fallback stays silent", async () => {
    const { alerter, sent } = newAlerter();
    await failNTimes(
      alerter,
      DEGRADE_AFTER_FAILURES + 3,
      "claude api error: rate_limit",
    );
    expect(sent).toEqual([]);
  });

  test("a success closes the incident, so the next outage alerts again", async () => {
    let clock = 0;
    const { alerter, sent } = newAlerter(() => clock);
    const err = "claude api error: authentication_failed";
    await failNTimes(alerter, DEGRADE_AFTER_FAILURES, err);
    expect(sent.length).toBe(1);

    alerter.noteSuccess("claude");
    // Still well inside the re-alert floor: dedup must be incident-scoped,
    // not purely time-scoped, or a fixed-then-rebroken primary goes quiet.
    clock += 60_000;
    await failNTimes(alerter, DEGRADE_AFTER_FAILURES, err);
    expect(sent.length).toBe(2);
  });

  test("an unbroken incident does not re-alert until the floor passes", async () => {
    let clock = 0;
    const { alerter, sent } = newAlerter(() => clock);
    const err = "claude api error: authentication_failed";
    await failNTimes(alerter, DEGRADE_AFTER_FAILURES, err);
    expect(sent.length).toBe(1);

    clock += REALERT_MS - 1;
    await failNTimes(alerter, 1, err);
    expect(sent.length).toBe(1);

    clock += 2;
    await failNTimes(alerter, 1, err);
    expect(sent.length).toBe(2);
  });

  test("a wedged harness a fallback absorbed stays silent", async () => {
    const { alerter, sent } = newAlerter();
    for (let i = 0; i < DEGRADE_AFTER_FAILURES + 2; i++) {
      alerter.noteFailure("claude", killText("idle"));
    }
    await alerter.noteDegraded({ harnessId: "claude", servedBy: "pi" });
    // Only `auth` pages: a timeout the chain routed around is #284's
    // deliberate silence, and splitting it out of `other` must not change that.
    expect(sent).toEqual([]);
  });

  test("persistent empty replies degrade like auth (#499)", async () => {
    const { alerter, sent } = newAlerter();
    // A single flake stays free — no cooldown (#499), no alert.
    await failNTimes(alerter, 1, "empty reply");
    expect(sent.length).toBe(0);
    // But empty on EVERY turn is dead, however clean the exit.
    await failNTimes(alerter, DEGRADE_AFTER_FAILURES - 1, "empty reply");
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("empty reply");
    expect(sent[0]).toContain("pi serving");
    // A success closes the incident like any other cause.
    alerter.noteSuccess("claude");
    await failNTimes(alerter, DEGRADE_AFTER_FAILURES - 1, "empty reply");
    expect(sent.length).toBe(1);
  });

  test("with no servedBy the alert says nobody covered the turn (#501)", async () => {
    // The single-harness empty-reply shape: the turn "completed" and the
    // user got "(no reply)". Naming a fallback here would tell the owner
    // they are still being answered, which is the opposite of the truth.
    const { alerter, sent } = newAlerter();
    for (let i = 0; i < DEGRADE_AFTER_FAILURES; i++) {
      alerter.noteFailure("pi", "empty reply");
      await alerter.noteDegraded({ harnessId: "pi" });
    }
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("pi empty reply");
    expect(sent[0]).toContain("no fallback left");
    expect(sent[0]).not.toContain("serving");
  });

  test("below the threshold an uncovered empty stays silent (#501)", async () => {
    const { alerter, sent } = newAlerter();
    for (let i = 0; i < DEGRADE_AFTER_FAILURES - 1; i++) {
      alerter.noteFailure("pi", "empty reply");
      await alerter.noteDegraded({ harnessId: "pi" });
    }
    expect(sent).toEqual([]);
  });
});

describe("mixed causes in one incident", () => {
  // The failure run is per-CAUSE. Feeding one cause per incident (as every
  // other test here does) cannot distinguish "counts auth failures" from
  // "counts failures and happens to read the last cause".
  test("429s do not inflate an auth count into a false alert", async () => {
    const { alerter, sent } = newAlerter();
    await failNTimes(
      alerter,
      DEGRADE_AFTER_FAILURES - 1,
      "claude api error: rate_limit",
    );
    // One auth blip on top. If the run were per-harness this would read as
    // "auth failure x3" and page the owner about a rate limit.
    await failNTimes(alerter, 1, "claude api error: authentication_failed");
    expect(sent).toEqual([]);
  });

  test("the count reflects auth failures only", async () => {
    const { alerter, sent } = newAlerter();
    await failNTimes(alerter, 4, "claude api error: rate_limit");
    await failNTimes(
      alerter,
      DEGRADE_AFTER_FAILURES,
      "claude api error: authentication_failed",
    );
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain(`\u00d7${DEGRADE_AFTER_FAILURES}`);
  });

  test("one stray non-auth failure cannot mute a dead token", async () => {
    const { alerter, sent } = newAlerter();
    await failNTimes(
      alerter,
      DEGRADE_AFTER_FAILURES + 2,
      "claude api error: authentication_failed",
    );
    expect(sent.length).toBe(1);
    alerter.noteSuccess("claude");

    // An empty reply counts as a failure (fallback.ts) and is its own
    // `empty` cause now (#499). Landing mid-run resets the auth tally —
    // a fresh run then has to build up to the threshold again, and the
    // re-alert floor keeps the second crossing silent within REALERT_MS.
    await failNTimes(alerter, 2, "claude api error: authentication_failed");
    await failNTimes(alerter, 1, "empty reply");
    await failNTimes(
      alerter,
      DEGRADE_AFTER_FAILURES,
      "claude api error: authentication_failed",
    );
    expect(sent.length).toBe(2);
  });
});

describe("send deadline", () => {
  test("a hanging sender cannot stall the turn it is reporting on", async () => {
    const alerter = new HarnessAlerter({
      // Never resolves — a nostr relay that accepts the socket and never ACKs.
      // `try/catch` in emit() does not cover this; only a deadline does.
      send: () => new Promise<void>(() => {}),
      sendTimeoutMs: 50,
    });
    const started = Date.now();
    await alerter.noteExhausted({
      harnessId: "claude",
      error: "claude api error: rate_limit",
      chain: ["claude"],
    });
    // Settled, and settled by the deadline rather than by the send.
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("exhausted alert", () => {
  test("names the rate limit and the missing fallback", async () => {
    const { alerter, sent } = newAlerter();
    await alerter.noteExhausted({
      harnessId: "claude",
      error: "claude api error: rate_limit",
      chain: ["claude"],
    });
    expect(sent.length).toBe(1);
    // One line: siren, harness, cause, and that nothing answered.
    expect(sent[0]).not.toContain("\n");
    expect(sent[0]).toContain("\ud83d\udea8 claude rate limited 429");
    // One harness: nothing was ever configured to fall back to.
    expect(sent[0]).toContain("no usable fallback configured [claude]");
  });

  test("fires for a non-rate-limit outage too — no reply was delivered", async () => {
    const { alerter, sent } = newAlerter();
    await alerter.noteExhausted({
      harnessId: "pi",
      error: "pi exited with code 1",
      chain: ["claude", "pi"],
    });
    expect(sent.length).toBe(1);
    // Not auth, not a rate limit: the generic label, and never a cause we
    // did not classify.
    expect(sent[0]).toContain("harness error");
    expect(sent[0]).not.toContain("rate limited");
    expect(sent[0]).toContain("[claude \u2192 pi]");
  });

  test("names a wedged harness instead of the generic 'harness error'", async () => {
    const { alerter, sent } = newAlerter();
    await alerter.noteExhausted({
      harnessId: "pi",
      error:
        killText("idle"),
      chain: ["pi"],
    });
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("\ud83d\udea8 pi timed out");
    expect(sent[0]).not.toContain("harness error");
    // A one-harness chain never had a fallback to lose.
    expect(sent[0]).toContain("no usable fallback configured [pi]");
    expect(sent[0]).not.toContain("no fallback left");
  });

  test("says 'no fallback left' only when the chain actually had one", async () => {
    const { alerter, sent } = newAlerter();
    await alerter.noteExhausted({
      harnessId: "pi",
      error: "pi exited with code 1",
      chain: ["claude", "pi"],
    });
    expect(sent[0]).toContain("no fallback left [claude \u2192 pi]");
    expect(sent[0]).not.toContain("no usable fallback configured");
  });

  test("is silent with no sender configured", async () => {
    const alerter = new HarnessAlerter();
    expect(alerter.enabled).toBe(false);
    await alerter.noteExhausted({
      harnessId: "claude",
      error: "claude api error: rate_limit",
      chain: ["claude"],
    });
    // No throw, nothing sent — one-shot CLI paths have no owner channel.
  });

  test("a throwing sender cannot break the turn", async () => {
    const alerter = new HarnessAlerter({
      send: () => {
        throw new Error("telegram down");
      },
    });
    await alerter.noteExhausted({
      harnessId: "claude",
      error: "claude api error: rate_limit",
      chain: ["claude"],
    });
  });
});

describe("exhausted alert — stderr preview (issue #462)", () => {
  test("surfaces last 1-2 stderr lines in the alert message", async () => {
    const { alerter, sent } = newAlerter();
    await alerter.noteExhausted({
      harnessId: "claude",
      error: "claude exited with code 1",
      chain: ["claude"],
      stderrTail: ["some old line", "rate limit exceeded", "retrying in 60s"],
    });
    expect(sent.length).toBe(1);
    // The last 2 lines appear in the alert, pipe-separated.
    expect(sent[0]).toContain("rate limit exceeded | retrying in 60s");
    // The older line is NOT surfaced.
    expect(sent[0]).not.toContain("some old line");
    // Still one line — the preview is appended, not on a new line.
    expect(sent[0]).not.toContain("\n");
  });

  test("omits the preview when no stderr was captured", async () => {
    const { alerter, sent } = newAlerter();
    await alerter.noteExhausted({
      harnessId: "claude",
      error: "claude exited with code 1",
      chain: ["claude"],
    });
    expect(sent.length).toBe(1);
    // No trailing separator — the message is identical to pre-#462.
    expect(sent[0]).toContain("turn undelivered");
    expect(sent[0]).not.toContain(" | ");
  });

  test("truncates long stderr lines to 200 chars for narrow channels", async () => {
    const { alerter, sent } = newAlerter();
    const longLine = "x".repeat(300);
    await alerter.noteExhausted({
      harnessId: "claude",
      error: "claude exited with code 1",
      chain: ["claude"],
      stderrTail: [longLine],
    });
    expect(sent.length).toBe(1);
    // The preview contains the truncated line (200 x's), not the full 300.
    expect(sent[0]).toContain("x".repeat(200));
    expect(sent[0]).not.toContain("x".repeat(201));
  });
});
