import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmod, writeFile } from "node:fs/promises";
import { parse } from "smol-toml";
import {
  applyHarnessChain,
  availabilityStateBins,
  detectAvailability,
  offeredHarnesses,
  pickableId,
  runHarness,
  runHarnessCheck,
  SUPPORTED_HARNESSES,
  whichBinary,
} from "../src/cli/harness.ts";
import * as harnessModule from "../src/cli/harness.ts";
import type { HarnessPrompts } from "../src/cli/harnessPrompts.ts";
import { checkConfiguredHarnesses } from "../src/lib/harnessAvailability.ts";
import type { Config } from "../src/config.ts";

describe("native-default wizard wiring", () => {
  test("native is the default primary (first in SUPPORTED_HARNESSES)", () => {
    expect(SUPPORTED_HARNESSES[0]).toBe("native");
    expect([...SUPPORTED_HARNESSES].sort()).toEqual(["claude", "codex", "native", "pi-host"]);
  });

  test("the Pi installer is gone: nothing in the harness CLI installs anything", () => {
    expect("piInstallCommand" in harnessModule).toBe(false);
    expect("installPi" in harnessModule).toBe(false);
    expect("defaultInstallRunner" in harnessModule).toBe(false);
  });

  test("offeredHarnesses: native always, host harnesses only when detected", () => {
    const none = { native: undefined, claude: undefined, codex: undefined, "pi-host": undefined };
    expect(offeredHarnesses(none)).toEqual(["native"]);
    expect(offeredHarnesses({ ...none, "pi-host": "/usr/bin/pi", claude: "/usr/bin/claude" }))
      .toEqual(["native", "claude", "pi-host"]);
  });

  test("pickableId: named native instances pick native; an entry not offered picks nothing", () => {
    const offered = ["native", "claude"] as const;
    expect(pickableId("pi-primary", offered)).toBe("native");
    expect(pickableId("pi-fallback", offered)).toBe("native");
    expect(pickableId("claude", offered)).toBe("claude");
    expect(pickableId("codex", offered)).toBeUndefined();
    expect(pickableId(undefined, offered)).toBeUndefined();
  });

  test("availabilityStateBins: native is never persisted; pi-host persists under `pi`", () => {
    expect(
      availabilityStateBins({
        native: "/usr/local/bin/phantombot",
        claude: "/usr/bin/claude",
        codex: undefined,
        "pi-host": "/usr/bin/pi",
      }),
    ).toEqual({ claude: "/usr/bin/claude", codex: undefined, pi: "/usr/bin/pi" });
  });
});

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-h-"));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("whichBinary", () => {
  test("returns the absolute path when bin is an absolute executable", async () => {
    expect(await whichBinary("/bin/sh")).toBe("/bin/sh");
  });

  test("returns undefined for a non-existent absolute path", async () => {
    expect(await whichBinary("/this/does/not/exist")).toBeUndefined();
  });

  test("walks $PATH for bare command names", async () => {
    expect(await whichBinary("sh")).toBeTruthy();
  });

  test("returns undefined for a bare command not on PATH", async () => {
    expect(
      await whichBinary("definitely-not-a-real-command-9999"),
    ).toBeUndefined();
  });
});

describe("applyHarnessChain", () => {
  test("writes the chain to [harnesses].chain", async () => {
    const path = join(workdir, "config.toml");
    await applyHarnessChain(path, ["claude", "native"]);
    const text = await readFile(path, "utf8");
    expect(text).toContain("[harnesses]");
    expect(text).toContain('chain = [ "claude", "native" ]');
  });

  test("supports a single-element chain", async () => {
    const path = join(workdir, "config.toml");
    await applyHarnessChain(path, ["native"]);
    const text = await readFile(path, "utf8");
    expect(text).toContain('chain = [ "native" ]');
  });

  test("in persona scope the chain is the plain [harnesses].chain", async () => {
    // A persona's own file describes one persona, so its chain is
    // `[harnesses].chain` — the key loadConfig reads first for that persona.
    // Writing the legacy table into a persona file would be dropped on read
    // and the change would silently do nothing (phantombot#439).
    const path = join(workdir, "lena-config.toml");
    await applyHarnessChain(path, ["native", "claude"], "lena", "persona");
    const text = await readFile(path, "utf8");
    expect(text).toContain('chain = [ "native", "claude" ]');
    expect(text).not.toContain("personas");
  });

  test("writes a persona override without changing the global chain", async () => {
    const path = join(workdir, "config.toml");
    await applyHarnessChain(path, ["codex", "native"]);
    await applyHarnessChain(path, ["claude", "codex"], "amanda");
    const text = await readFile(path, "utf8");
    expect(text).toContain('chain = [ "codex", "native" ]');
    expect(text).toContain("[harnesses.personas.amanda]");
    expect(text).toContain('chain = [ "claude", "codex" ]');
  });
});

describe("detectAvailability (issue #450)", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "phantombot-detect-"));
    const claude = join(dir, "claude");
    await writeFile(claude, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(claude, 0o755);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Absolute on POSIX (and POSIX-absolute on Windows, which is the #450 shape)
  // but inside a fresh temp dir, so it can never exist on any machine.
  const staleAbsoluteBin = () => join(dir, "stale-claude-450");

  const configWithStaleBin = (bin: string) =>
    ({
      harnesses: {
        chain: ["claude"],
        claude: { bin },
        pi: { bin: "definitely-missing-pi" },
        codex: { bin: "definitely-missing-codex", model: "" },
      },
    }) as unknown as Config;

  test("agrees with checkConfiguredHarnesses on a stale absolute bin", async () => {
    // The reported bug: `doctor`/`run` resolve claude via the absolute-bin ->
    // bare-name retry, while the wizard's bare which() reported NOT FOUND on
    // the very same config. The two detectors must not disagree.
    const config = configWithStaleBin(staleAbsoluteBin());

    const fromDoctor = await checkConfiguredHarnesses(config, dir);
    const fromWizard = await detectAvailability(config, dir);

    expect(fromDoctor.find((h) => h.id === "claude")?.resolved).toBe(join(dir, "claude"));
    expect(fromWizard.claude).toBe(join(dir, "claude"));
  });

  test("still reports a genuinely missing host harness as missing", async () => {
    // The fix must not paper over a real absence — otherwise the wizard would
    // offer a harness that cannot start.
    const avail = await detectAvailability(configWithStaleBin(staleAbsoluteBin()), dir);
    expect(avail["pi-host"]).toBeUndefined();
    expect(avail.codex).toBeUndefined();
  });

  test("native is always detected: it is this binary", async () => {
    const avail = await detectAvailability(configWithStaleBin(staleAbsoluteBin()), dir);
    expect(avail.native).toBe(process.execPath);
  });

  test("resolves a bare configured bin from PATH", async () => {
    const avail = await detectAvailability(configWithStaleBin("claude"), dir);
    expect(avail.claude).toBe(join(dir, "claude"));
  });
});

describe("runHarness native → native", () => {
  test("both slots are configured as named native instances; no host-config question is asked", async () => {
    const selects: Array<{ message: string }> = [];
    const selectAnswers: Array<string | undefined> = [
      "native", // primary
      "native", // fallback
      "", // primary slot provider: (none)
      "", // fallback slot provider: (none)
    ];

    const q: HarnessPrompts = {
      select: async (input) => {
        selects.push(input);
        return selectAnswers.shift() as never;
      },
      text: async () => "",
      password: async () => "",
      confirm: async () => true,
      note: () => {},
      intro: () => {},
      outro: () => {},
      cancel: () => {},
      canRunInteractiveInstaller: false,
    };

    const configPath = join(workdir, "config.toml");
    const config = {
      configPath,
      personasDir: join(workdir, "personas"),
      defaultPersona: "robbie",
      harnesses: {
        chain: ["claude"],
        pi: { bin: "/usr/bin/pi" },
        codex: { bin: undefined, model: "" },
        claude: { bin: undefined },
      },
    } as unknown as Config;

    const status = await runHarness({
      config,
      availability: { native: process.execPath, claude: undefined, codex: undefined, "pi-host": undefined },
      prompts: q,
      piCommand: [join(workdir, "no-such-engine")],
      serviceControl: {
        isActive: async () => false,
        restart: async () => ({ ok: true }),
        start: async () => ({ ok: true }),
        stop: async () => ({ ok: true }),
        rerenderUnitIfStale: async () => ({ ok: true, rerendered: false }),
      },
    });

    expect(status).toBe(0);
    expect(selects.some((s) => s.message.includes("how should models be configured"))).toBe(false);
    // The primary menu offered only what this host can run.
    const toml = parse(await readFile(configPath, "utf8")) as {
      harnesses: { chain: string[]; instances: Record<string, { type: string }> };
    };
    expect(toml.harnesses.chain).toEqual(["pi-primary", "pi-fallback"]);
    expect(toml.harnesses.instances["pi-primary"]!.type).toBe("native");
    expect(toml.harnesses.instances["pi-fallback"]!.type).toBe("native");
  });

  test("the primary menu lists only harnesses this host can run", async () => {
    let firstOptions: readonly { value: string }[] = [];
    const q: HarnessPrompts = {
      select: async (input) => {
        if (firstOptions.length === 0) firstOptions = input.options as never;
        return undefined as never;
      },
      text: async () => "",
      password: async () => "",
      confirm: async () => true,
      note: () => {},
      intro: () => {},
      outro: () => {},
      cancel: () => {},
      canRunInteractiveInstaller: false,
    };
    const config = {
      configPath: join(workdir, "config.toml"),
      personasDir: join(workdir, "personas"),
      defaultPersona: "robbie",
      harnesses: { chain: ["claude"], pi: { bin: "pi" }, claude: { bin: "claude" }, codex: { bin: "codex", model: "" } },
    } as unknown as Config;
    const code = await runHarness({
      config,
      availability: { native: process.execPath, claude: "/usr/bin/claude", codex: undefined, "pi-host": undefined },
      prompts: q,
    });
    expect(code).toBe(1); // cancelled at the first question
    expect(firstOptions.map((o) => o.value)).toEqual(["native", "claude"]);
  });
});

describe("runHarnessCheck", () => {
  const prompts = (over: Partial<HarnessPrompts> = {}) => {
    const notes: Array<{ body: string; title?: string }> = [];
    const confirms: string[] = [];
    const q: HarnessPrompts = {
      select: async () => undefined as never,
      text: async () => undefined as never,
      password: async () => undefined as never,
      confirm: async ({ message }) => {
        confirms.push(message);
        return true;
      },
      note: (body, title) => {
        notes.push({ body, title });
      },
      intro: () => {},
      outro: () => {},
      cancel: () => {},
      canRunInteractiveInstaller: false,
      ...over,
    };
    return { q, notes, confirms };
  };

  const config = () =>
    ({
      configPath: join(workdir, "config.toml"),
      personasDir: join(workdir, "personas"),
      defaultPersona: "phantom",
      harnesses: {
        chain: ["claude"],
        pi: { bin: "/nonexistent/pi" },
        codex: { bin: "/nonexistent/codex" },
        claude: { bin: "/bin/sh" },
      },
    }) as unknown as Config;

  test("shows detected harnesses (native built in) and returns 0", async () => {
    const { q, notes } = prompts();
    const code = await runHarnessCheck({
      config: config(),
      prompts: q,
      availability: { native: process.execPath, claude: "/bin/sh", codex: undefined, "pi-host": undefined },
    });
    expect(code).toBe(0);
    const detected = notes.find((n) => n.title === "Detected harnesses");
    expect(detected?.body).toContain("[built in]  native");
    expect(notes.some((n) => n.title === "Native harness")).toBe(false);
  });

  test("no host harness: explains the built-in native harness and never offers an install", async () => {
    const { q, notes, confirms } = prompts();
    const code = await runHarnessCheck({
      config: config(),
      prompts: q,
      availability: { native: process.execPath, claude: undefined, codex: undefined, "pi-host": undefined },
    });
    expect(code).toBe(0);
    expect(notes.find((n) => n.title === "Native harness")?.body).toContain("provider API key");
    expect(confirms.some((m) => m.toLowerCase().includes("install"))).toBe(false);
    expect(confirms.some((m) => m.includes("Continue to phantombot TUI"))).toBe(true);
  });

  test("dry run behaves the same — there is nothing to install either way", async () => {
    const { q, confirms } = prompts();
    const code = await runHarnessCheck({
      config: config(),
      prompts: q,
      dryRun: true,
      availability: { native: process.execPath, claude: undefined, codex: undefined, "pi-host": undefined },
    });
    expect(code).toBe(0);
    expect(confirms.some((m) => m.toLowerCase().includes("install"))).toBe(false);
  });

  test("returns 1 when user declines or cancels continue prompt", async () => {
    const { q } = prompts({ confirm: async () => false });
    const code = await runHarnessCheck({
      config: config(),
      prompts: q,
      availability: { native: process.execPath, claude: "/bin/sh", codex: undefined, "pi-host": undefined },
    });
    expect(code).toBe(1);
  });
});
