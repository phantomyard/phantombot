/**
 * Tests for runLifecycleAction — the shared driver behind `phantombot
 * start | stop | restart`. We inject a fake ServiceControl and capture the
 * output sinks, so no real supervisor is touched. What we assert:
 *
 *   - each action calls the matching ServiceControl verb (start/stop/restart)
 *   - success prints the right past-tense line and exits 0
 *   - failure prints the stderr + a copy-pasteable manual hint and exits 1
 */

import { describe, expect, test } from "bun:test";

import { runLifecycleAction } from "../src/lib/serviceLifecycle.ts";
import type { ServiceControl } from "../src/lib/platform.ts";

function sink() {
  let text = "";
  return {
    write: (s: string) => {
      text += s;
      return true;
    },
    get text() {
      return text;
    },
  };
}

/**
 * Fake ServiceControl that records which verb was invoked and returns a
 * canned result for it. isActive/rerender are inert — the lifecycle driver
 * never calls them.
 */
function fakeSvc(
  results: Partial<Record<"start" | "stop" | "restart", { ok: boolean; stderr?: string }>> = {},
) {
  const calls: string[] = [];
  const svc: ServiceControl = {
    async isActive() {
      return true;
    },
    async start() {
      calls.push("start");
      return results.start ?? { ok: true };
    },
    async stop() {
      calls.push("stop");
      return results.stop ?? { ok: true };
    },
    async restart() {
      calls.push("restart");
      return results.restart ?? { ok: true };
    },
    async rerenderUnitIfStale() {
      return { rerendered: false };
    },
  };
  return { svc, calls };
}

describe("runLifecycleAction — success path", () => {
  for (const [action, done] of [
    ["start", "started"],
    ["stop", "stopped"],
    ["restart", "restarted"],
  ] as const) {
    test(`${action} calls svc.${action}, prints "${done}", exits 0`, async () => {
      const { svc, calls } = fakeSvc();
      const out = sink();
      const err = sink();
      const code = await runLifecycleAction({
        action,
        serviceControl: svc,
        out,
        err,
      });
      expect(code).toBe(0);
      expect(calls).toEqual([action]);
      expect(out.text).toBe(`phantombot ${done}.\n`);
      expect(err.text).toBe("");
    });
  }
});

describe("runLifecycleAction — failure path", () => {
  test("surfaces the backend stderr, a manual hint, and exits 1", async () => {
    const { svc } = fakeSvc({ start: { ok: false, stderr: "no linger" } });
    const out = sink();
    const err = sink();
    const code = await runLifecycleAction({
      action: "start",
      serviceControl: svc,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(out.text).toBe("");
    expect(err.text).toContain("start failed: no linger");
    // A copy-pasteable manual command + a status hint are offered.
    expect(err.text).toMatch(/run '.+' manually/);
    expect(err.text).toContain("check status with:");
  });

  test("falls back to 'unknown' when the backend gives no stderr", async () => {
    const { svc } = fakeSvc({ stop: { ok: false } });
    const err = sink();
    const code = await runLifecycleAction({
      action: "stop",
      serviceControl: svc,
      out: sink(),
      err,
    });
    expect(code).toBe(1);
    expect(err.text).toContain("stop failed: unknown");
  });
});
