/**
 * Manual probe — finds Pi's effective argv ceiling. Gated behind
 * RUN_PI_PROBE=1 so it doesn't run in normal test invocations (and
 * because it requires a real `pi` binary on PATH).
 *
 *   RUN_PI_PROBE=1 bun test tests/probe-pi-argmax.test.ts
 *
 * Use the result to tune harnesses.pi.maxPayloadBytes in config.toml.
 */

import { describe, test, expect } from "bun:test";
import { PiHarness } from "../src/harnesses/pi.ts";
import type { HarnessRequest } from "../src/harnesses/types.ts";

const RUN = process.env.RUN_PI_PROBE === "1";

describe.skipIf(!RUN)("Pi ARG_MAX probe", () => {
  test("finds the largest payload pi will accept without spawn-EBIG", async () => {
    const harness = new PiHarness({
      bin: process.env.PHANTOMBOT_PI_BIN ?? "pi",
      maxPayloadBytes: Number.MAX_SAFE_INTEGER, // disable internal precheck
    });

    // Sweep payload sizes in 50 KB steps from 50 KB to 2 MB.
    const sizes = [
      50_000, 100_000, 250_000, 500_000, 1_000_000, 1_500_000, 2_000_000,
    ];

    let lastSucceeded = 0;
    for (const sz of sizes) {
      const padding = "x".repeat(sz);
      const req: HarnessRequest = {
        systemPrompt: "you are pi",
        userMessage: padding,
        history: [],
        workingDir: process.cwd(),
        timeoutMs: 30_000,
      };

      let result: "ok" | "error" = "ok";
      try {
        for await (const chunk of harness.invoke(req)) {
          if (chunk.type === "error") {
            result = "error";
            // eslint-disable-next-line no-console
            console.log(
              `[probe] size=${sz} ERROR ${chunk.error} (recoverable=${chunk.recoverable})`,
            );
            break;
          }
          if (chunk.type === "done") {
            // eslint-disable-next-line no-console
            console.log(`[probe] size=${sz} OK (done)`);
            break;
          }
        }
      } catch (e) {
        result = "error";
        // eslint-disable-next-line no-console
        console.log(`[probe] size=${sz} THROW ${(e as Error).message}`);
      }

      if (result === "ok") lastSucceeded = sz;
      else break;
    }

    // eslint-disable-next-line no-console
    console.log(`[probe] last size pi accepted: ${lastSucceeded} bytes`);
    expect(lastSucceeded).toBeGreaterThan(0);
  }, 600_000); // 10-minute test timeout for the sweep
});
