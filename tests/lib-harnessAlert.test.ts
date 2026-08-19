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

  test("anything else is 'other' — a timeout must not page the owner", () => {
    expect(
      classifyFailure("claude timed out after 300000ms (hard wall-clock cap)"),
    ).toBe("other");
    expect(classifyFailure("claude exited with code 1")).toBe("other");
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

    // An empty reply counts as a failure (fallback.ts) and classifies as
    // `other`. Landing mid-run must not silence the rest of the incident.
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
    expect(sent[0]).toContain("no fallback left");
    // The chain answers "out of what?" — one harness means "add a fallback".
    expect(sent[0]).toContain("[claude]");
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
