/**
 * `applyDefaultPersona` must write the layer that WINS (issue #471).
 *
 * REGRESSION test. The first cut wrote `default_persona` into config.toml, but
 * `config.ts` resolves the default as
 * `state.default_persona ?? globalToml.default_persona` — state wins. On any
 * host that has ever created a persona, switched with `phantombot persona
 * <name>`, or been healed by `healDefaultPersonaIfBroken` (i.e. effectively
 * every host), that write returned `{ ok: true }`, restarted the daemon, and
 * changed nothing — the worst shape of bug for the one setting that decides
 * which phantom owns `/update` and `/restart`.
 *
 * Also pins the two behaviours it must share with `runSwitchDefault`: the
 * append-only audit record, and the refusal to let a persona AGENT re-point the
 * host-wide default.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../src/config.ts";
import type { ServiceControl } from "../src/lib/platform.ts";
import { applyDefaultPersona } from "../src/tui/actions.ts";

let root: string;
const saved: Record<string, string | undefined> = {};
const ENV = ["PHANTOMBOT_STATE", "PHANTOMBOT_STATE_AUDIT", "PHANTOMBOT_PERSONA"] as const;

const noopService: ServiceControl = {
  isActive: async () => true,
  start: async () => ({ ok: true }),
  stop: async () => ({ ok: true }),
  restart: async () => ({ ok: true }),
} as unknown as ServiceControl;

function configAt(dir: string, defaultPersona: string): Config {
  return {
    configPath: join(dir, "config.toml"),
    defaultPersona,
  } as unknown as Config;
}

const statePath = () => join(root, "state.json");
const auditPath = () => join(root, "state-audit.log");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "phantombot-tui-default-"));
  for (const k of ENV) saved[k] = process.env[k];
  process.env.PHANTOMBOT_STATE = statePath();
  process.env.PHANTOMBOT_STATE_AUDIT = auditPath();
  delete process.env.PHANTOMBOT_PERSONA;
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("applyDefaultPersona", () => {
  test("writes state.json, which is the layer that wins over config.toml", async () => {
    writeFileSync(statePath(), JSON.stringify({ default_persona: "alice" }));

    const r = await applyDefaultPersona({
      config: configAt(root, "alice"),
      persona: "bob",
      serviceControl: noopService,
    });

    expect(r.ok).toBe(true);
    const state = JSON.parse(readFileSync(statePath(), "utf8")) as {
      default_persona?: string;
    };
    expect(state.default_persona).toBe("bob");
    // config.toml is NOT the mechanism, and must not be half-written either.
    expect(existsSync(join(root, "config.toml"))).toBe(false);
  });

  test("preserves other state fields written by concurrent writers", async () => {
    writeFileSync(
      statePath(),
      JSON.stringify({ default_persona: "alice", harness_bins: { claude: "/usr/bin/claude" } }),
    );

    await applyDefaultPersona({
      config: configAt(root, "alice"),
      persona: "bob",
      serviceControl: noopService,
    });

    const state = JSON.parse(readFileSync(statePath(), "utf8")) as {
      harness_bins?: Record<string, string>;
    };
    expect(state.harness_bins?.claude).toBe("/usr/bin/claude");
  });

  test("leaves the forensic audit record that identifies the writer", async () => {
    writeFileSync(statePath(), JSON.stringify({ default_persona: "alice" }));

    await applyDefaultPersona({
      config: configAt(root, "alice"),
      persona: "bob",
      serviceControl: noopService,
    });

    const entry = JSON.parse(readFileSync(auditPath(), "utf8").trim()) as {
      from?: string;
      to?: string;
    };
    expect(entry.from).toBe("alice");
    expect(entry.to).toBe("bob");
  });

  test("refuses when running as a persona agent", async () => {
    writeFileSync(statePath(), JSON.stringify({ default_persona: "alice" }));
    process.env.PHANTOMBOT_PERSONA = "bob";

    const r = await applyDefaultPersona({
      config: configAt(root, "alice"),
      persona: "bob",
      serviceControl: noopService,
    });

    expect(r.ok).toBe(false);
    expect(r.error).toContain("PHANTOMBOT_PERSONA");
    const state = JSON.parse(readFileSync(statePath(), "utf8")) as {
      default_persona?: string;
    };
    expect(state.default_persona).toBe("alice");
  });

  test("already the default is a no-op success, not a restart", async () => {
    writeFileSync(statePath(), JSON.stringify({ default_persona: "alice" }));
    let restarts = 0;
    const r = await applyDefaultPersona({
      config: configAt(root, "alice"),
      persona: "alice",
      serviceControl: {
        ...noopService,
        restart: async () => {
          restarts++;
          return { ok: true };
        },
      } as ServiceControl,
    });
    expect(r.ok).toBe(true);
    expect(restarts).toBe(0);
    expect(existsSync(auditPath())).toBe(false);
  });
});
