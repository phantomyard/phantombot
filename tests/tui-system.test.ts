import { describe, expect, test } from "bun:test";

import { filterLogs } from "../src/tui/screens/System.tsx";
import { systemSnapshot } from "../src/tui/systemSnapshot.ts";
import type { HostSnapshot } from "../src/tui/snapshot.ts";
import type { LogLine } from "../src/tui/logBuffer.ts";

const NOW = new Date("2026-09-01T12:00:00Z");

describe("System log filters", () => {
  const lines: LogLine[] = [
    {
      at: NOW.getTime() - 60_000,
      level: "error",
      persona: "kai",
      type: "tick",
      msg: "job failed",
      raw: "job failed",
    },
    {
      at: NOW.getTime() - 7_200_000,
      level: "info",
      persona: "lena",
      type: "daemon",
      msg: "listener ready",
      raw: "listener ready",
    },
  ];

  test("composes type, persona, time, and text filters", () => {
    expect(
      filterLogs(
        lines,
        { type: "tick", persona: "kai", time: "15m", text: "FAILED" },
        NOW.getTime(),
      ),
    ).toEqual([lines[0]!]);
    expect(
      filterLogs(
        lines,
        { type: "daemon", persona: "all", time: "1h", text: "" },
        NOW.getTime(),
      ),
    ).toEqual([]);
  });
});

describe("System service snapshot", () => {
  test("degrades missing runtime markers instead of throwing", () => {
    const host = {
      version: "test",
      updateChannel: "stable",
      defaultPersona: "phantom",
      personasDir: "/definitely/missing",
      serviceActive: false,
      personas: [],
    } satisfies HostSnapshot;
    const snapshot = systemSnapshot(host, NOW);
    expect(snapshot.services.find((s) => s.id === "daemon")?.state).toBe(
      "failed",
    );
    expect(snapshot.services.find((s) => s.id === "heartbeat")?.state).toBe(
      "unavailable",
    );
    expect(snapshot.services.find((s) => s.id === "tick")?.state).toBeDefined();
  });
});
