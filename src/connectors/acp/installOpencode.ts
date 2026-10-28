/**
 * `phantombot acp install opencode` backend — register Phantombot as a
 * selectable MODEL inside OpenCode (CLI + Desktop), on Linux, macOS and Windows.
 *
 * OpenCode does not consume external ACP agents: `opencode acp` makes *OpenCode*
 * the agent that Zed/JetBrains spawn, so there is no setting that points OpenCode
 * at `phantombot acp`. The integration therefore goes the other way — Phantombot
 * ships a tiny provider package (src/connectors/acp/opencode/provider/index.mjs,
 * embedded in this binary as base64) and registers it as an OpenCode provider.
 * The package spawns `phantombot acp` per conversation over stdio, so there is no
 * daemon, no port, no token, and it works while the Phantombot service is down.
 *
 * ## Why `aisdk:` and not a plain package
 *
 * A plain `file://` provider package must export `model()` returning OpenCode's
 * own `LanguageModel` class instance (`LanguageModelSchema` is an `instanceof`
 * check against a class that lives inside OpenCode's binary). An external module
 * cannot import `@opencode/ai` — verified against v2.2.0, every such specifier
 * fails to resolve — so that route can only ever fail with "Schema validation
 * failed". OpenCode's AI-SDK route (`package: "aisdk:<specifier>"`) instead
 * imports the module, picks the first export whose name starts with `create`,
 * and uses the returned `LanguageModelV3` objects, which are plain duck-typed
 * objects. See the header of the provider module for the full reasoning.
 *
 * ## What lands in the user's config
 *
 *   { "providers": { "phantombot": {
 *       "name": "Phantombot",
 *       "package": "aisdk:file:///…/connectors/opencode/index.mjs",
 *       "settings": { "command": "<abs path to this binary>" },
 *       "models": { "omar": { "name": "Phantombot — omar" }, … } } } }
 *
 * One model per local persona, because the provider treats the model id AS the
 * persona name (`phantombot acp --persona <model id>`). Two OpenCode sessions on
 * two model ids are two independent phantoms; two sessions on the SAME model id
 * share that persona's memory and vault.
 *
 * JSONC-safe merge, data-loss-proof: parse with `jsonc-parser` (the library
 * OpenCode's own docs tooling uses), abort without writing on a malformed file,
 * back the original up, write atomically. Every other key — including other
 * providers, comments and formatting — survives untouched.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser";

import type { WriteSink } from "../../lib/io.ts";
import {
  OPENCODE_PROVIDER_FILENAME,
  OPENCODE_PROVIDER_SHA256,
  OPENCODE_PROVIDER_SOURCE_BASE64,
} from "../../lib/opencodeProviderAsset.generated.ts";

/** Provider id under `providers` — also the `-m phantombot/<model>` prefix. */
export const OPENCODE_PROVIDER_ID = "phantombot";

export interface OpencodeDeps {
  platform: string;
  env: Record<string, string | undefined>;
  homedir(): string;
  exists(path: string): boolean;
  readFile(path: string): string | undefined;
  writeFile(path: string, data: string): void;
  mkdirp(path: string): void;
  rename(from: string, to: string): void;
  /**
   * Run `opencode <args>` and capture stdout. Returns undefined when the CLI is
   * absent or the command fails — `debug paths config` is a convenience, never a
   * hard requirement.
   */
  runOpencode(args: string[]): { code: number; stdout: string } | undefined;
}

export function defaultOpencodeDeps(): OpencodeDeps {
  return {
    platform: process.platform,
    env: process.env as Record<string, string | undefined>,
    homedir,
    exists: (path) => existsSync(path),
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
    writeFile: (path, data) => writeFileSync(path, data, { encoding: "utf8", mode: 0o644 }),
    mkdirp: (path) => mkdirSync(path, { recursive: true }),
    rename: (from, to) => renameSync(from, to),
    runOpencode: (args) => {
      try {
        const result = spawnSync("opencode", args, {
          encoding: "utf8",
          timeout: 20_000,
          shell: process.platform === "win32",
        });
        if (result.error || typeof result.stdout !== "string") return undefined;
        return { code: result.status ?? 1, stdout: result.stdout };
      } catch {
        return undefined;
      }
    },
  };
}

export type OpencodeInstallAction =
  /** OpenCode is not installed on this machine — nothing done. */
  | "not-detected"
  /** Our block already matches this binary and persona set — no write. */
  | "current"
  /** Provider block was absent; we wrote it. */
  | "registered"
  /** Provider block existed but differed; we rewrote it. */
  | "updated"
  /** The config file is not parseable — left untouched. */
  | "error";

export interface InstallOpencodeResult {
  /** 0 success/no-op, 1 a real failure. */
  code: number;
  action: OpencodeInstallAction;
  /** Resolved OpenCode config path ("" when OpenCode was not detected). */
  configPath: string;
  /** Where the provider module was staged. */
  modulePath: string;
  /** Human-readable detail (the doctor/log line). */
  message: string;
  /** Set when the legacy v1 `provider` block was seen and ignored by v2. */
  legacyKeyWarning?: string;
}

export interface InstallOpencodeOptions {
  /** Absolute path to the phantombot binary OpenCode should spawn. */
  binaryPath: string;
  /** Personas to expose as models. Empty ⇒ the caller supplies none; we still write the provider. */
  personas?: string[];
  /** Override the config file (tests). */
  configPath?: string;
  /** Override the staged module path (tests). */
  modulePath?: string;
  /** Write when the block is missing/stale. False = report only. */
  repair?: boolean;
  deps?: Partial<OpencodeDeps>;
}

/**
 * Persona names to expose as OpenCode models — every subdirectory of the
 * personas root, sorted. A missing directory means "no personas yet", which is
 * not an error (fresh installs have none).
 */
export function personaModelNames(personasDir: string): string[] {
  try {
    return readdirSync(personasDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Join path segments using the TARGET platform's rules (not the host's). */
function joinFor(platform: string, ...segments: string[]): string {
  return platform === "win32" ? win32.join(...segments) : posix.join(...segments);
}

/** Where the provider module is staged for OpenCode to import. */
export function defaultOpencodeModulePath(deps: Partial<OpencodeDeps> = {}): string {
  const d = { ...defaultOpencodeDeps(), ...deps };
  if (d.platform === "win32") {
    const local =
      d.env.LOCALAPPDATA && d.env.LOCALAPPDATA.trim().length > 0
        ? d.env.LOCALAPPDATA
        : joinFor("win32", d.homedir(), "AppData", "Local");
    return joinFor("win32", local, "phantombot", "connectors", "opencode", OPENCODE_PROVIDER_FILENAME);
  }
  const data =
    d.env.XDG_DATA_HOME && d.env.XDG_DATA_HOME.trim().length > 0
      ? d.env.XDG_DATA_HOME
      : join(d.homedir(), ".local", "share");
  return joinFor(d.platform, data, "phantombot", "connectors", "opencode", OPENCODE_PROVIDER_FILENAME);
}

/** Default location for OpenCode's user config file, per platform. */
export function fallbackOpencodeConfigPath(deps: Partial<OpencodeDeps> = {}): string {
  const d = { ...defaultOpencodeDeps(), ...deps };
  const file = (dir: string): string => {
    // OpenCode reads BOTH names; prefer whichever the user already has.
    for (const name of ["opencode.jsonc", "opencode.json"]) {
      const candidate = joinFor(d.platform, dir, name);
      if (d.exists(candidate)) return candidate;
    }
    return joinFor(d.platform, dir, "opencode.json");
  };
  if (d.platform === "win32") {
    const appData = d.env.APPDATA || joinFor("win32", d.homedir(), "AppData", "Roaming");
    return file(joinFor("win32", appData, "opencode"));
  }
  const xdg =
    d.env.XDG_CONFIG_HOME && d.env.XDG_CONFIG_HOME.trim().length > 0
      ? d.env.XDG_CONFIG_HOME
      : join(d.homedir(), ".config");
  return file(joinFor(d.platform, xdg, "opencode"));
}

/**
 * Resolve the config file OpenCode will actually read.
 *
 * `$OPENCODE_CONFIG` wins (it is the documented override and is what the
 * provider was probed with). Otherwise ask OpenCode itself — `opencode debug
 * paths config` prints the canonical CONFIG DIRECTORY on all three platforms and
 * survives layout changes between releases — and only then fall back to the
 * documented per-platform location. Note the command prints a directory, not a
 * file: the file inside it is `opencode.jsonc` or `opencode.json`.
 */
export function resolveOpencodeConfigPath(deps: Partial<OpencodeDeps> = {}): {
  configPath: string;
  detected: boolean;
} {
  const d = { ...defaultOpencodeDeps(), ...deps };
  const explicit = d.env.OPENCODE_CONFIG;
  if (explicit && explicit.trim().length > 0) {
    return { configPath: explicit.trim(), detected: true };
  }
  const probe = d.runOpencode(["debug", "paths", "config"]);
  const dir = probe && probe.code === 0 ? probe.stdout.trim().split(/\r?\n/).pop() ?? "" : "";
  if (dir && dir.length > 0) {
    const inside = dir.endsWith(".json") || dir.endsWith(".jsonc") ? dir : null;
    if (inside) return { configPath: inside, detected: true };
    for (const name of ["opencode.jsonc", "opencode.json"]) {
      const candidate = join(dir, name);
      if (d.exists(candidate)) return { configPath: candidate, detected: true };
    }
    // The directory exists ⇒ OpenCode is installed; write the canonical name.
    if (d.exists(dir)) return { configPath: join(dir, "opencode.json"), detected: true };
  }
  const fallback = fallbackOpencodeConfigPath(d);
  return { configPath: fallback, detected: d.exists(dirname(fallback)) };
}

/**
 * `file://` URL for a module path, on the TARGET platform.
 *
 * `pathToFileURL` uses the HOST's rules, so a Windows path resolved on Linux (as
 * the installer's own tests and any cross-platform config review will do) comes
 * out as a relative POSIX URL — which OpenCode then cannot import. Windows needs
 * `file:///C:/…`: backslashes normalised, each segment percent-encoded, and the
 * drive letter left alone. UNC paths (`\\server\share`) keep their host.
 */
export function fileUrlForPath(modulePath: string, platform: string = process.platform): string {
  const isWindowsPath = /^[A-Za-z]:[\\/]/.test(modulePath) || modulePath.startsWith("\\\\");
  if (platform !== "win32" && !isWindowsPath) return pathToFileURL(modulePath).href;

  const normalised = modulePath.replace(/\\/g, "/");
  const encode = (segment: string) => encodeURIComponent(segment).replace(/%3A/gi, ":");
  if (normalised.startsWith("//")) {
    // UNC: the first segment is the host and must not be encoded.
    const [, host, ...rest] = normalised.split("/");
    return `file://${host}/${rest.map(encode).join("/")}`;
  }
  return `file:///${normalised.split("/").map(encode).join("/")}`;
}

/** The `providers.phantombot` subtree this installer owns. */
export function phantombotOpencodeProviderBlock(input: {
  binaryPath: string;
  modulePath: string;
  personas: string[];
  /** Target platform for the `file://` URL. Default: the host. */
  platform?: string;
}): Record<string, unknown> {
  const models: Record<string, unknown> = {};
  for (const persona of input.personas) {
    models[persona] = { name: `Phantombot — ${persona}` };
  }
  return {
    name: "Phantombot",
    package: `aisdk:${fileUrlForPath(input.modulePath, input.platform)}`,
    settings: { command: input.binaryPath },
    models,
  };
}

/** The exact bytes of the provider module (decoded from the embedded asset). */
export function opencodeProviderSource(): Buffer {
  return Buffer.from(OPENCODE_PROVIDER_SOURCE_BASE64, "base64");
}

/** True when the file on disk is already this exact module. */
function moduleIsCurrent(path: string, deps: OpencodeDeps): boolean {
  const existing = deps.readFile(path);
  if (existing === undefined) return false;
  // Compare bytes as text: both sides come from our own UTF-8 source, and the
  // asset's sha256 is asserted against the repo file by its own test.
  return existing === opencodeProviderSource().toString("utf8");
}

/** Stable JSON comparison (key order independent) for the idempotency check. */
function sameJson(a: unknown, b: unknown): boolean {
  const canon = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canon);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
          .map(([k, v]) => [k, canon(v)]),
      );
    }
    return value;
  };
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

/**
 * Install / refresh the OpenCode provider registration.
 *
 * Never throws: every failure is returned as `{ code: 1, action: "error" }`, so
 * the startup reconcile loop can call it fire-and-forget.
 */
export function installOpencode(options: InstallOpencodeOptions): InstallOpencodeResult {
  const deps: OpencodeDeps = { ...defaultOpencodeDeps(), ...options.deps };
  const modulePath = options.modulePath ?? defaultOpencodeModulePath(deps);

  try {
    const resolved = options.configPath
      ? { configPath: options.configPath, detected: true }
      : resolveOpencodeConfigPath(deps);
    const configPath = resolved.configPath;

    // Detection: never provision a config for an editor the user doesn't have.
    if (!resolved.detected) {
      return {
        code: 0,
        action: "not-detected",
        configPath: "",
        modulePath,
        message: "OpenCode not detected (no config directory and no `opencode` CLI on PATH)",
      };
    }

    const block = phantombotOpencodeProviderBlock({
      binaryPath: options.binaryPath,
      modulePath,
      personas: options.personas ?? [],
      platform: deps.platform,
    });

    // Read + parse BEFORE writing anything, so a malformed file aborts the whole
    // install rather than leaving a new module on disk with no registration.
    const raw = deps.readFile(configPath);
    const text = raw ?? "{}\n";
    const errors: ParseError[] = [];
    const parsed = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length > 0) {
      const first = errors[0]!;
      return {
        code: 1,
        action: "error",
        configPath,
        modulePath,
        message: `OpenCode config is not parseable (${printParseErrorCode(first.error)} at offset ${first.offset}) — left untouched`,
      };
    }

    const legacy =
      parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as Record<string, unknown>).provider !== undefined && (parsed as Record<string, unknown>).providers === undefined
        ? "config has a v1 `provider` block; OpenCode v2 only reads `providers` (plural) and silently drops the old one"
        : undefined;

    const current = (parsed as Record<string, unknown> | undefined)?.providers as
      | Record<string, unknown>
      | undefined;
    const existing = current?.[OPENCODE_PROVIDER_ID];
    const alreadyCurrent = sameJson(existing, block) && moduleIsCurrent(modulePath, deps);

    if (alreadyCurrent) {
      return {
        code: 0,
        action: "current",
        configPath,
        modulePath,
        message: `already registered in ${configPath}`,
        legacyKeyWarning: legacy,
      };
    }

    if (options.repair === false) {
      return {
        code: 0,
        action: existing === undefined ? "registered" : "updated",
        configPath,
        modulePath,
        message: "needs (re)registration; repair is off",
        legacyKeyWarning: legacy,
      };
    }

    // Stage the module first: a registration pointing at a missing file is worse
    // than no registration.
    if (!moduleIsCurrent(modulePath, deps)) {
      deps.mkdirp(dirname(modulePath));
      deps.writeFile(modulePath, opencodeProviderSource().toString("utf8"));
    }

    const edits = modify(text, ["providers", OPENCODE_PROVIDER_ID], block, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes("\r\n") ? "\r\n" : "\n" },
    });
    const next = applyEdits(text, edits);

    if (raw !== undefined) {
      deps.writeFile(`${configPath}.phantombot-bak`, raw);
    }
    const temp = `${configPath}.phantombot-tmp-${process.pid}`;
    deps.writeFile(temp, next);
    deps.rename(temp, configPath);

    return {
      code: 0,
      action: existing === undefined ? "registered" : "updated",
      configPath,
      modulePath,
      message:
        (existing === undefined ? "registered" : "updated") +
        ` in ${configPath}` +
        (options.personas && options.personas.length > 0
          ? ` (models: ${options.personas.join(", ")})`
          : " (no personas found — no models added)"),
      legacyKeyWarning: legacy,
    };
  } catch (error) {
    return {
      code: 1,
      action: "error",
      configPath: "",
      modulePath,
      message: (error as Error).message,
    };
  }
}

/** sha256 embedded in this build, for diagnostics/tests. */
export const OPENCODE_PROVIDER_ASSET_SHA256 = OPENCODE_PROVIDER_SHA256;

/** Human-readable outcome line for the CLI. */
export function describeOpencodeInstall(result: InstallOpencodeResult): string {
  switch (result.action) {
    case "not-detected":
      return "OpenCode not detected — nothing to do. Install OpenCode, then re-run `phantombot acp install opencode`.";
    case "current":
      return `OpenCode: already registered (${result.configPath}).`;
    case "registered":
    case "updated":
      return `OpenCode: ${result.message}. Restart OpenCode (or reload the window) to pick it up.`;
    case "error":
      return `OpenCode: ${result.message}`;
  }
}

/** Write the human-readable outcome to a sink (CLI default: stdout/stderr). */
export function printOpencodeInstall(result: InstallOpencodeResult, out: WriteSink, err: WriteSink): void {
  const sink = result.code === 0 ? out : err;
  sink.write(`${describeOpencodeInstall(result)}\n`);
  if (result.legacyKeyWarning) {
    err.write(`  warning: ${result.legacyKeyWarning}\n`);
  }
}
