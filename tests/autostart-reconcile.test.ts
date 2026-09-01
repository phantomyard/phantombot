/**
 * Autostart reconciler — the pure planner (lib/autostartReconcile.ts).
 *
 * The reconciler runs UNPROMPTED on every TUI and daemon start and rewrites
 * the user's config.toml, so "bulletproof" here means the rules hold for
 * inputs nobody thought to write a case for. The last block therefore fuzzes
 * the planner over randomised hosts and asserts the safety INVARIANTS
 * directly, rather than trusting the table of examples above it.
 *
 * Integration (real config.toml round-trips, the platform seams, the TUI and
 * daemon call sites) lives in tui-legacy-default-migration.test.ts.
 */

import { describe, expect, test } from "bun:test";

import {
  type AutostartFacts,
  type AutostartMode,
  planAutostartReconcile,
} from "../src/lib/autostartReconcile.ts";

function facts(over: Partial<AutostartFacts> = {}): AutostartFacts {
  return {
    personasOnDisk: ["lena", "kai", "jake"],
    defaultPersona: "lena",
    defaultProvenance: "config",
    autostartPersonas: [],
    autostartModes: {},
    bootProbe: {},
    ...over,
  };
}

/** Apply a plan to a fact set — used to assert idempotence and invariants. */
function applyToFacts(f: AutostartFacts, p: ReturnType<typeof planAutostartReconcile>): AutostartFacts {
  const modes: Record<string, AutostartMode> = { ...f.autostartModes };
  for (const m of p.modes) {
    if (m.to === undefined) delete modes[m.persona];
    else modes[m.persona] = m.to;
  }
  return {
    ...f,
    // The real applier heals a broken default via healDefaultPersonaIfBroken;
    // its CHOICE is that function's business, so model only the postcondition
    // the planner cares about: the default now exists.
    ...(p.healDefaultPersona ? { defaultPersona: f.personasOnDisk[0]! } : {}),
    autostartPersonas: p.autostartPersonas ? p.autostartPersonas.to : f.autostartPersonas,
    autostartModes: modes,
  };
}

describe("planAutostartReconcile — the on/off axis (autostart_personas)", () => {
  test("a healthy host plans nothing", () => {
    const plan = planAutostartReconcile(
      facts({ autostartPersonas: ["kai"], autostartModes: { lena: "login", kai: "login" } }),
    );
    expect(plan.empty).toBe(true);
    expect(plan.modes).toEqual([]);
  });

  test("entries naming personas that do not exist are pruned", () => {
    const plan = planAutostartReconcile(
      facts({ autostartPersonas: ["kai", "Phantom"], autostartModes: { lena: "login", kai: "login" } }),
    );
    expect(plan.autostartPersonas?.to).toEqual(["kai"]);
  });

  test("duplicates collapse, surviving order is preserved", () => {
    const plan = planAutostartReconcile(
      facts({
        autostartPersonas: ["jake", "kai", "jake"],
        autostartModes: { lena: "login", kai: "login", jake: "login" },
      }),
    );
    expect(plan.autostartPersonas?.to).toEqual(["jake", "kai"]);
  });

  test("nothing is ever ADDED to the list", () => {
    // A repair must never make a persona start booting that was not booting.
    const plan = planAutostartReconcile(
      facts({ autostartPersonas: [], autostartModes: { lena: "login" } }),
    );
    expect(plan.autostartPersonas).toBeUndefined();
  });

  test("an empty persona list (unreadable dir) plans nothing at all", () => {
    const plan = planAutostartReconcile(
      facts({ personasOnDisk: [], autostartPersonas: ["kai"], autostartModes: { zz: "boot" } }),
    );
    expect(plan).toEqual({ healDefaultPersona: false, modes: [], empty: true });
  });
});

describe("planAutostartReconcile — default_persona", () => {
  test("a default naming no persona on disk is flagged for heal", () => {
    const plan = planAutostartReconcile(facts({ defaultPersona: "Phantom" }));
    expect(plan.healDefaultPersona).toBe(true);
  });

  test("an env-pinned default is never healed", () => {
    // The loudest layer the operator has. A broken one is theirs to see.
    const plan = planAutostartReconcile(
      facts({ defaultPersona: "Phantom", defaultProvenance: "env" }),
    );
    expect(plan.healDefaultPersona).toBe(false);
  });

  test("a builtin-provenance default is neither healed nor recorded", () => {
    // Nobody chose it: it is the bare fallback name, so it is not evidence of
    // an autostart decision and inventing a record for it fabricates one.
    // The name deliberately EXISTS on disk — with a non-existent name the
    // existence filter hides the bug, and this assertion passes vacuously.
    const plan = planAutostartReconcile(
      facts({ defaultPersona: "lena", defaultProvenance: "builtin" }),
    );
    expect(plan.healDefaultPersona).toBe(false);
    expect(plan.modes).toEqual([]);
    expect(plan.empty).toBe(true);
  });

  test("a builtin default that does not exist is not healed either", () => {
    // Distinct path from the one above: heal is skipped because nothing chose
    // this name, not because the name happens to resolve. The legacy
    // adoption in resolveOpeningScreen owns making an implicit default
    // explicit; reconciliation must not race it.
    const plan = planAutostartReconcile(
      facts({ defaultPersona: "phantom", defaultProvenance: "builtin" }),
    );
    expect(plan.healDefaultPersona).toBe(false);
    expect(plan.modes).toEqual([]);
  });

  test("a chosen, existing default is served and gets a record", () => {
    const plan = planAutostartReconcile(facts({ defaultProvenance: "state" }));
    expect(plan.modes).toEqual([
      {
        persona: "lena",
        to: "login",
        reason: "served with no mode record; login is the conservative label",
      },
    ]);
  });
});

describe("planAutostartReconcile — the login/boot axis (autostart_modes)", () => {
  test("a served persona with no record is backfilled", () => {
    const plan = planAutostartReconcile(facts({ autostartPersonas: ["kai"] }));
    expect(plan.modes.map((m) => [m.persona, m.to])).toEqual([
      ["lena", "login"],
      ["kai", "login"],
    ]);
  });

  test("backfill is PER-PERSONA, not all-or-nothing", () => {
    // The regression that motivated this module: the previous one-shot
    // migration was gated on the whole table being empty, so a host with one
    // record left every later persona unlabelled — rendered Off — forever.
    const plan = planAutostartReconcile(
      facts({ autostartPersonas: ["kai", "jake"], autostartModes: { lena: "boot" } }),
    );
    expect(plan.modes.map((m) => m.persona).sort()).toEqual(["jake", "kai"]);
  });

  test("no signal (undefined probe) never overwrites an existing record", () => {
    // This is Linux. `systemctl --user is-enabled` is true on every standard
    // install, so it cannot witness a Boot CHOICE — and on Linux the record
    // is the teardown authority, so a wrong one disables a working daemon.
    const plan = planAutostartReconcile(
      facts({
        autostartPersonas: ["kai"],
        autostartModes: { lena: "boot", kai: "boot" },
        bootProbe: { lena: undefined, kai: undefined },
      }),
    );
    expect(plan.empty).toBe(true);
  });

  test("no signal backfills the conservative label, never boot", () => {
    const plan = planAutostartReconcile(
      facts({ autostartPersonas: ["kai"], bootProbe: { lena: undefined, kai: undefined } }),
    );
    expect(plan.modes.every((m) => m.to === "login")).toBe(true);
  });

  test("a provenance-carrying probe corrects a stale record, both directions", () => {
    const plan = planAutostartReconcile(
      facts({
        autostartPersonas: ["kai"],
        autostartModes: { lena: "login", kai: "boot" },
        bootProbe: { lena: true, kai: false },
      }),
    );
    expect(plan.modes.map((m) => [m.persona, m.from, m.to])).toEqual([
      ["lena", "login", "boot"],
      ["kai", "boot", "login"],
    ]);
  });

  test("records for personas that no longer exist are removed", () => {
    const plan = planAutostartReconcile(
      facts({ autostartModes: { lena: "login", Phantom: "boot" }, defaultProvenance: "config" }),
    );
    expect(plan.modes).toEqual([
      { persona: "Phantom", from: "boot", reason: "no persona directory — stale mode record" },
    ]);
  });

  test("a record is never backfilled for a persona this same plan is pruning", () => {
    // Served is computed from the PRUNED list, so the two rules cannot
    // disagree with each other within one plan.
    const plan = planAutostartReconcile(
      facts({ autostartPersonas: ["Phantom"], autostartModes: { lena: "login" } }),
    );
    expect(plan.modes).toEqual([]);
    expect(plan.autostartPersonas?.to).toEqual([]);
  });

  test("an unserved but existing persona keeps its record", () => {
    // Deleting it would silently forget a login/boot choice the moment a
    // persona is toggled Off, so toggling back on would lose it.
    const plan = planAutostartReconcile(
      facts({ autostartModes: { lena: "login", jake: "boot" }, bootProbe: { jake: undefined } }),
    );
    expect(plan.empty).toBe(true);
  });
});

describe("planAutostartReconcile — invariants under fuzz", () => {
  const NAMES = ["lena", "kai", "jake", "Phantom", "megan", "matt"];
  const MODES: AutostartMode[] = ["login", "boot"];
  const PROVENANCE = ["env", "state", "config", "builtin"] as const;

  function randomFacts(rand: () => number): AutostartFacts {
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const onDisk = NAMES.filter(() => rand() < 0.6);
    const list = NAMES.filter(() => rand() < 0.4);
    // Duplicates are a real on-disk shape (hand-edited config.toml).
    if (list.length && rand() < 0.3) list.push(list[0]!);
    const modes: Record<string, AutostartMode> = {};
    for (const n of NAMES) if (rand() < 0.4) modes[n] = pick(MODES);
    const probe: Record<string, boolean | undefined> = {};
    for (const n of NAMES) {
      const r = rand();
      probe[n] = r < 0.34 ? undefined : r < 0.67;
    }
    return {
      personasOnDisk: onDisk,
      ...(rand() < 0.9 ? { defaultPersona: pick(NAMES) } : {}),
      defaultProvenance: pick(PROVENANCE),
      autostartPersonas: list,
      autostartModes: modes,
      bootProbe: probe,
    };
  }

  // Deterministic PRNG so a failure is reproducible from the seed alone.
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  }

  test("5000 random hosts: every invariant holds, and the plan is idempotent", () => {
    for (let seed = 1; seed <= 5000; seed++) {
      const f = randomFacts(lcg(seed));
      const plan = planAutostartReconcile(f);
      const after = applyToFacts(f, plan);
      const why = `seed ${seed}: ${JSON.stringify(f)}`;

      // 1. NEVER adds an autostart slot — a repair cannot make a persona boot.
      for (const n of after.autostartPersonas) {
        expect(f.autostartPersonas.includes(n), why).toBe(true);
      }
      // 2. Never writes a record for a persona that does not exist.
      for (const n of Object.keys(after.autostartModes)) {
        if (f.personasOnDisk.length === 0) continue; // the refuse-to-act case
        expect(f.personasOnDisk.includes(n), why).toBe(true);
      }
      // 3. Never invents `boot` without a probe that witnessed it. This is the
      //    Linux teardown-safety property: no signal, no boot record.
      for (const m of plan.modes) {
        if (m.to !== "boot") continue;
        expect(f.bootProbe[m.persona] === true, why).toBe(true);
      }
      // 4. Never leaves a served, existing persona unlabelled (renders Off).
      if (f.personasOnDisk.length > 0) {
        const served = [
          ...(after.defaultProvenance !== "builtin" && after.defaultPersona
            ? [after.defaultPersona]
            : []),
          ...after.autostartPersonas,
        ].filter((n) => f.personasOnDisk.includes(n));
        for (const n of served) {
          // A healed default is chosen by healDefaultPersonaIfBroken AFTER
          // this plan was computed, so it legitimately has no record yet —
          // the next start records it. Everything else must be labelled now.
          if (plan.healDefaultPersona && n === after.defaultPersona) continue;
          expect(n in after.autostartModes, why).toBe(true);
        }
      }
      // 5. Idempotent: re-planning on the applied result is a no-op.
      const second = planAutostartReconcile(after);
      if (plan.healDefaultPersona) continue; // heal's choice is modelled, not planned
      expect(second.empty, `${why}\nsecond plan: ${JSON.stringify(second)}`).toBe(true);
    }
  });
});
