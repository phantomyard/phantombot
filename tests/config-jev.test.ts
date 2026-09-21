/**
 * The `[jev]` config block: absent means absent (zero behaviour change),
 * defaults are safe, env beats TOML, and a plaintext api_key is ignored.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.ts";

let workdir: string;
const SAVED_CONFIG = process.env.PHANTOMBOT_CONFIG;
const savedEnv: Record<string, string | undefined> = {};
const ENV_NAMES = [
  "PHANTOMBOT_JEV_API_KEY",
  "PHANTOMBOT_JEV_PROVIDER",
  "PHANTOMBOT_JEV_JUDGE",
  "PHANTOMBOT_JEV_JUDGE_MODE",
  "PHANTOMBOT_JEV_ROUTER",
];

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "phantombot-jevcfg-"));
  process.env.PHANTOMBOT_CONFIG = join(workdir, "config.toml");
  process.env.XDG_CONFIG_HOME = join(workdir, "xdg-config");
  process.env.XDG_DATA_HOME = join(workdir, "xdg-data");
  for (const name of ENV_NAMES) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(async () => {
  if (SAVED_CONFIG === undefined) delete process.env.PHANTOMBOT_CONFIG;
  else process.env.PHANTOMBOT_CONFIG = SAVED_CONFIG;
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name]!;
  }
  await rm(workdir, { recursive: true, force: true });
});

async function writePersonaToml(config: { personasDir: string }, body: string) {
  const dir = join(config.personasDir, "phantom");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.toml"), body);
}

describe("config [jev]", () => {
  test("no block and no env ⇒ jev is undefined — zero behaviour change", async () => {
    const config = await loadConfig();
    expect(config.jev).toBeUndefined();
  });

  test("a bare block parses with safe defaults: both consumers disabled", async () => {
    let config = await loadConfig();
    await writePersonaToml(config, '[jev]\nprovider = "openrouter"\n');
    config = await loadConfig();
    expect(config.jev).toBeDefined();
    expect(config.jev!.provider).toBe("openrouter");
    expect(config.jev!.model).toBe("typesafe/jev-1.13");
    expect(config.jev!.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(config.jev!.keyEnv).toBe("PHANTOMBOT_JEV_API_KEY");
    expect(config.jev!.judge).toEqual({
      enabled: false,
      timeoutMs: 1500,
      threshold: 70,
      failClosed: false,
    });
    expect(config.jev!.router).toEqual({
      enabled: false,
      timeoutMs: 800,
    });
  });

  test("parses consumers and the typesafe provider with its endpoint", async () => {
    let config = await loadConfig();
    await writePersonaToml(
      config,
      '[jev]\nprovider = "typesafe"\nbase_url = "https://ts.example/v1"\n\n' +
        '[jev.judge]\nenabled = true\nthreshold = 65\nfail_closed = true\n\n' +
        '[jev.router]\nenabled = true\ntimeout_ms = 250\n',
    );
    config = await loadConfig();
    expect(config.jev!.provider).toBe("typesafe");
    expect(config.jev!.baseUrl).toBe("https://ts.example/v1");
    expect(config.jev!.judge.enabled).toBe(true);
    expect(config.jev!.judge.threshold).toBe(65);
    expect(config.jev!.judge.failClosed).toBe(true);
    expect(config.jev!.router.enabled).toBe(true);
    expect(config.jev!.router.timeoutMs).toBe(250);
  });

  test("env beats TOML", async () => {
    let config = await loadConfig();
    await writePersonaToml(config, '[jev]\nprovider = "typesafe"\n');
    process.env.PHANTOMBOT_JEV_PROVIDER = "openrouter";
    process.env.PHANTOMBOT_JEV_JUDGE = "true";
    config = await loadConfig();
    expect(config.jev!.provider).toBe("openrouter");
    expect(config.jev!.judge.enabled).toBe(true);
  });

  test("an UNKNOWN provider still loads (coerced to openrouter) — loudly", async () => {
    // A future decision-model vendor written into a today-binary config
    // must not wedge startup or silently rewrite the operator's intent.
    // The value coerces to the OpenRouter transport (unchanged behaviour)
    // but log.warn names it and points at the portability surface, so the
    // next decision-model vendor is anticipated without a release dance.
    let config = await loadConfig();
    await writePersonaToml(
      config,
      '[jev]\nprovider = "acme"\nbase_url = "https://api.acme.dev/v1"\n',
    );
    const lines: string[] = [];
    const original = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      config = await loadConfig();
    } finally {
      process.stderr.write = original;
    }
    expect(config.jev!.provider).toBe("openrouter");
    // The operator's base_url is honoured regardless of the transport name.
    expect(config.jev!.baseUrl).toBe("https://api.acme.dev/v1");
    // The coercion is NOT silent: the warning names the stated provider.
    const msgs = lines
      .flatMap((l) => l.split("\n"))
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l).msg as string);
    expect(
      msgs.some((m) => m.includes("provider 'acme'") && m.includes("key_env")),
    ).toBe(true);
  });

  test("a legacy mode key is INERT — an enabled consumer always decides", async () => {
    // `mode = "shadow"` shipped in a pre-merge draft. A host that still has
    // it in config.toml must not read as configured-but-not-deciding: the
    // key is ignored, not honoured, and never resurfaces on the type.
    let config = await loadConfig();
    await writePersonaToml(
      config,
      '[jev]\nprovider = "openrouter"\n\n' +
        '[jev.judge]\nenabled = true\nmode = "shadow"\n',
    );
    config = await loadConfig();
    expect(config.jev!.judge.enabled).toBe(true);
    expect("mode" in config.jev!.judge).toBe(false);
  });

  test("REJECTS an out-of-range judge threshold — 101 would silently disable every hold", async () => {
    const config = await loadConfig();
    await writePersonaToml(
      config,
      '[jev]\nprovider = "openrouter"\n\n[jev.judge]\nenabled = true\nthreshold = 101\n',
    );
    await expect(loadConfig()).rejects.toThrow("threshold must be 0..100");
  });

  test("REJECTS a negative judge threshold — it would hold everything", async () => {
    const config = await loadConfig();
    await writePersonaToml(
      config,
      '[jev]\nprovider = "openrouter"\n\n[jev.judge]\nenabled = true\nthreshold = -1\n',
    );
    await expect(loadConfig()).rejects.toThrow("threshold must be 0..100");
  });

  test("REJECTS non-positive timeouts — they reach AbortSignal.timeout and can throw", async () => {
    const config = await loadConfig();
    await writePersonaToml(
      config,
      '[jev]\nprovider = "openrouter"\n\n[jev.judge]\ntimeout_ms = 0\n',
    );
    await expect(loadConfig()).rejects.toThrow(
      "[jev.judge] timeout_ms must be 1..30000",
    );
    await writePersonaToml(
      config,
      '[jev]\nprovider = "openrouter"\n\n[jev.router]\ntimeout_ms = -5\n',
    );
    await expect(loadConfig()).rejects.toThrow(
      "[jev.router] timeout_ms must be 1..30000",
    );
  });

  test("the key resolves from the env under key_env, never from TOML", async () => {
    let config = await loadConfig();
    await writePersonaToml(
      config,
      '[jev]\nprovider = "openrouter"\napi_key = "sk-plaintext-is-ignored"\n',
    );
    config = await loadConfig();
    expect(config.jev!.apiKey).toBeUndefined();

    process.env.PHANTOMBOT_JEV_API_KEY = "sk-from-env";
    config = await loadConfig();
    expect(config.jev!.apiKey).toBe("sk-from-env");
  });
});
