/**
 * `restartSelf` is the one slash-command route to `selfRestart`. An embedded
 * (engine-hosted) channel must never reach it: on Windows `selfRestart` exits
 * the process without consulting `serviceControl`, closing the host app.
 */
import { describe, expect, test } from "bun:test";

import { restartSelf } from "../src/channels/commands.ts";
import type { ServiceControl } from "../src/lib/platform.ts";

const svc = {} as ServiceControl;

describe("restartSelf", () => {
  test("embedded: refuses without calling selfRestart", async () => {
    let called = 0;
    const r = await restartSelf({ embedded: true, serviceControl: svc }, async () => {
      called++;
      return { ok: true };
    });
    expect(r.ok).toBe(false);
    expect(called).toBe(0);
  });

  test("not embedded: delegates to selfRestart with the context's service control", async () => {
    let seen: ServiceControl | undefined;
    const r = await restartSelf({ serviceControl: svc }, async (opts) => {
      seen = opts.serviceControl;
      return { ok: true };
    });
    expect(r.ok).toBe(true);
    expect(seen).toBe(svc);
  });
});
