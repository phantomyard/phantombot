/**
 * The pi engine EMBEDDED in the phantombot binary — what the `native` harness
 * runs.
 *
 * Why embed: phantombot should always have a working brain out of the box. A
 * fresh host with no claude, codex or pi installed still gets a harness; it
 * only needs a provider key. The routing schema phantombot writes
 * (`[harnesses.pi.routing]`) is tied to the pi version we ship and test, so
 * native mode ALWAYS uses this engine, even when the host has its own pi. The
 * host's pi is a separate harness (`pi-host`) configured by its owner.
 *
 * Shape: pi is compiled INTO the binary and reached through a hidden
 * self-exec subcommand, `<phantombot> __pi <pi args>`. The harness still spawns
 * it as a SUBPROCESS, so crash isolation, the startup timer, the idle killer
 * and per-spawn env reload all work exactly as they do for a host pi.
 *
 * Three facts from the embedding spike (2026-09-13) shape this file:
 *   1. Import pi's UNBUNDLED `dist/` modules. Pi's `dist/bundle/cli.js` breaks
 *      extension loading inside a compiled binary (`Cannot find module jiti`).
 *      The package `exports` map does not expose `dist/`, so there are two
 *      resolution paths (`piDistModule`, `piThemeFiles`). COMPILED: literal
 *      relative paths into this checkout's node_modules, which the bundler
 *      inlines at build time. FROM SOURCE — `bun src/index.ts`, and phantombot
 *      installed as a DEPENDENCY, where the package manager hoists pi next to
 *      phantombot and a relative node_modules path does not exist — files are
 *      read from pi's real package root, located through its package.json
 *      (the one subpath pi's exports map still answers).
 *   2. A compiled pi needs `PI_PACKAGE_DIR` pointing at a directory holding its
 *      `package.json` and `theme/*.json`, or it dies at startup with
 *      `ENOENT theme/dark.json`. Those files are embedded here (JSON imports)
 *      and extracted to a version-stamped data dir. Only set it when running
 *      compiled: under `bun src/index.ts` pi resolves its real package dir and
 *      an override would point its theme lookup at the wrong layout.
 *   3. Attribution is an inline extension factory handed to pi's `main()`, not
 *      a file on disk. It is loaded ONLY here, so ONLY native mode reports as
 *      Phantomyard's Phantombot; host harnesses keep their default headers.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ENV_PI_AGENT_DIR, nativeAgentDir, nativeAgentEnv } from "./nativeAgentDir.ts";
import { withPersonaEnv } from "./envBootstrap.ts";
import { phantombotEscortExtension, type ToolCallHookApi } from "./escort.ts";

/** Hidden argv[2] that turns the phantombot binary into the pi CLI. */
export const EMBEDDED_PI_SUBCOMMAND = "__pi";

/** The pi version compiled into this binary (pinned exactly in package.json). */
export const EMBEDDED_PI_VERSION: string = (piPackageJson() as { version: string }).version;

/**
 * Child-env var carrying the embedded pi invocation as a JSON argv array. The
 * capability-routing extension's delegate spawner (spawnPi.ts) reads it so a
 * `look_at_image` delegate re-enters THIS engine instead of looking for a
 * host `pi` on PATH (which a native-only host does not have).
 */
export const ENV_PHANTOMBOT_PI_COMMAND = "PHANTOMBOT_PI_COMMAND";

/** Native-mode attribution (decided 2026-09-13). */
export const PHANTOMBOT_APP_URL = "https://phantombot.bot";
export const PHANTOMBOT_APP_TITLE = "Phantomyard's Phantombot";

/**
 * Headers OpenRouter (and other OpenAI-compatible aggregators) read for app
 * attribution. `X-OpenRouter-Title` is OpenRouter's current name for the title
 * header; `X-Title` is the older one it still honours.
 */
export function attributionHeaders(): Record<string, string> {
  return {
    "HTTP-Referer": PHANTOMBOT_APP_URL,
    "X-OpenRouter-Title": PHANTOMBOT_APP_TITLE,
    "X-Title": PHANTOMBOT_APP_TITLE,
  };
}

/** The slice of pi's ExtensionAPI the attribution extension touches. */
export interface ProviderHeadersHookApi {
  on(
    event: "before_provider_headers",
    handler: (event: {
      headers?: Record<string, string | null | undefined>;
    }) => unknown,
  ): void;
}

/** Inline pi extension: stamp phantombot attribution on every provider call. */
export function phantombotAttributionExtension(pi: ProviderHeadersHookApi): void {
  pi.on("before_provider_headers", (event) => {
    const headers = event.headers ?? {};
    Object.assign(headers, attributionHeaders());
    return headers;
  });
}

/**
 * Are we running as a `bun build --compile` binary? Same test pi itself uses:
 * compiled module URLs live under `$bunfs` (POSIX) or `~BUN` (Windows).
 */
export function isCompiledBinary(moduleUrl: string = import.meta.url): boolean {
  return (
    moduleUrl.includes("$bunfs") ||
    moduleUrl.includes("~BUN") ||
    moduleUrl.includes("%7EBUN")
  );
}

/**
 * The argv prefix that starts the embedded pi. Compiled: the binary itself.
 * From source: the bun runtime re-running this checkout's entry point (so the
 * dev loop and `bun test` exercise the same self-exec path).
 */
export function embeddedPiCommand(
  opts: { execPath?: string; moduleUrl?: string; entry?: string } = {},
): string[] {
  const execPath = opts.execPath ?? process.execPath;
  if (isCompiledBinary(opts.moduleUrl)) return [execPath, EMBEDDED_PI_SUBCOMMAND];
  const entry = opts.entry ?? resolve(import.meta.dir, "..", "index.ts");
  return [execPath, entry, EMBEDDED_PI_SUBCOMMAND];
}

/**
 * The inline extensions the embedded pi runs with. The escort extension is
 * THE enforcement point of the escort for `native` (issue #702): it is inert
 * unless the harness set an escort context in this process's env. Kept as a
 * function so tests pin that runEmbeddedPi registers it.
 */
export function embeddedPiExtensionFactories(): Array<(pi: never) => unknown> {
  return [
    phantombotAttributionExtension as never,
    ((pi: ToolCallHookApi) => phantombotEscortExtension(pi)) as never,
  ];
}

/**
 * The argv prefix that re-enters THIS phantombot (no subcommand): the binary
 * itself when compiled, `bun <entry>` from source. The escort's claude hook
 * runs `<this> __escort` (lib/escort.ts).
 */
export function phantombotSelfCommand(
  opts: { execPath?: string; moduleUrl?: string; entry?: string } = {},
): string[] {
  return embeddedPiCommand(opts).slice(0, -1);
}

/**
 * Pi's package.json. Compiled: the literal require is what makes the bundler
 * embed it. From source: read from pi's real package root.
 */
function piPackageJson(): unknown {
  if (isCompiledBinary()) {
    return require("../../node_modules/@earendil-works/pi-coding-agent/package.json");
  }
  return JSON.parse(readFileSync(join(piPackageRoot(), "package.json"), "utf8"));
}

/**
 * Pi's package root on disk. Only meaningful from source (a checkout or a
 * dependency install); a compiled binary has no such directory. Located
 * through pi's package.json — the one subpath its exports map answers.
 */
export function piPackageRoot(): string {
  return dirname(
    Bun.resolveSync("@earendil-works/pi-coding-agent/package.json", import.meta.dir),
  );
}

const PI_THEME_DIR = "dist/modes/interactive/theme";

/**
 * Pi's two theme files. Compiled: the literal requires are what makes the
 * bundler embed them. From source: read from pi's real package root.
 */
function piThemeFiles(): { dark: unknown; light: unknown } {
  if (isCompiledBinary()) {
    return {
      dark: require("../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json"),
      light: require("../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/light.json"),
    };
  }
  const dir = join(piPackageRoot(), PI_THEME_DIR);
  return {
    dark: JSON.parse(readFileSync(join(dir, "dark.json"), "utf8")),
    light: JSON.parse(readFileSync(join(dir, "light.json"), "utf8")),
  };
}

let assetFiles: Map<string, string> | undefined;

/**
 * The files a compiled pi needs under PI_PACKAGE_DIR (relative path → content).
 * Serialised the same way on both resolution paths, so the content — and the
 * hash in the extraction dir name — is identical wherever it was read from.
 */
export function embeddedPiAssetFiles(): Map<string, string> {
  if (!assetFiles) {
    const themes = piThemeFiles();
    assetFiles = new Map([
      ["package.json", JSON.stringify(piPackageJson(), null, 2) + "\n"],
      ["theme/dark.json", JSON.stringify(themes.dark, null, 2) + "\n"],
      ["theme/light.json", JSON.stringify(themes.light, null, 2) + "\n"],
    ]);
  }
  return new Map(assetFiles);
}

/** Short content hash of the asset set — part of the extraction dir name. */
export const EMBEDDED_PI_ASSETS_HASH: string = (() => {
  const h = createHash("sha256");
  for (const [rel, content] of [...embeddedPiAssetFiles()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    h.update(rel).update("\0").update(content).update("\0");
  }
  return h.digest("hex").slice(0, 12);
})();

/**
 * Where this binary's pi assets live. Version + hash in the name means an
 * upgrade extracts next to (never over) the files a still-running older
 * daemon's children are reading.
 */
export function embeddedPiPackageDir(dataHome: string): string {
  return join(
    dataHome,
    "phantombot",
    "embedded-pi",
    `${EMBEDDED_PI_VERSION}-${EMBEDDED_PI_ASSETS_HASH}`,
  );
}

export interface EmbeddedPiAssetsStatus {
  dir: string;
  /** Relative paths that are absent or differ from the embedded content. */
  drifted: string[];
}

/** Non-writing check (doctor). */
export function embeddedPiAssetsStatus(dir: string): EmbeddedPiAssetsStatus {
  const drifted: string[] = [];
  for (const [rel, content] of embeddedPiAssetFiles()) {
    const full = join(dir, rel);
    let current: string | undefined;
    try {
      current = existsSync(full) ? readFileSync(full, "utf8") : undefined;
    } catch {
      current = undefined;
    }
    if (current !== content) drifted.push(rel);
  }
  return { dir, drifted };
}

/**
 * Extract (or repair) the assets. Idempotent: only missing/different files are
 * written, each via temp file + rename so a concurrent reader never sees a
 * half-written theme. Synchronous so the `__pi` entry can call it before pi's
 * module graph loads. Returns the relative paths it wrote.
 */
export function ensureEmbeddedPiAssets(dir: string): { dir: string; wrote: string[] } {
  const { drifted } = embeddedPiAssetsStatus(dir);
  const files = embeddedPiAssetFiles();
  for (const rel of drifted) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    const tmp = `${full}.${process.pid}.tmp`;
    writeFileSync(tmp, files.get(rel)!, "utf8");
    renameSync(tmp, full);
  }
  return { dir, wrote: drifted };
}

/**
 * Child env for a native pi spawn: the package dir (compiled only) and the
 * self-exec command for delegates. `dataHome` is injected so this module never
 * imports config.ts (the `__pi` fast path must stay light).
 */
export function embeddedPiChildEnv(dataHome: string): Record<string, string> {
  const env: Record<string, string> = {
    [ENV_PHANTOMBOT_PI_COMMAND]: JSON.stringify(embeddedPiCommand()),
  };
  if (isCompiledBinary()) {
    env.PI_PACKAGE_DIR = ensureEmbeddedPiAssets(embeddedPiPackageDir(dataHome)).dir;
  }
  return env;
}

/**
 * Escape hatch that suppresses the settings-entry catalog refresh, so a
 * rendered Settings screen never spawns a network child in tests/CI.
 */
export const ENV_PI_MODELS_SYNC_OFF = "PHANTOMBOT_PI_MODELS_SYNC_OFF";

/**
 * Personas whose catalog refresh is already running in THIS process, keyed
 * `dataHome\0persona`. Settings is mount/unmount, not a modal: without this the
 * operator paging in and out of the screen stacks concurrent network children
 * for the same persona. Cleared on a launch failure so a later visit retries.
 */
const piModelsSyncInFlight = new Set<string>();

/** The only part of a spawned child this helper touches. */
interface DetachedChild {
  on(event: "error", listener: () => void): unknown;
  unref(): unknown;
}

/**
 * Best-effort `__pi update --models` for the persona whose Settings screen is
 * open, so a model the engine learned about since launch is visible without
 * restarting phantombot. Deliberately NOT run at startup: a refresh is a
 * network round trip, and the only moment it matters is while someone is
 * reading the model list.
 *
 * Scoped to that persona's OWN agent dir — pi keeps the catalog per agent dir
 * and phantombot keeps one per persona, so an unscoped child would refresh
 * whatever persona the ambient environment happens to name.
 *
 * Never fatal: a synchronous throw, a launch failure, or nothing on PATH are
 * all swallowed. The `error` listener is REQUIRED — spawn reports ENOENT
 * asynchronously, and an unhandled `error` event would take the TUI down.
 *
 * Fires for the NEXT read, not this one: the spawn is detached and nothing
 * waits on it, so a model list already being fetched by the screen this visit
 * opened can still be the pre-refresh catalog. Blocking the screen to close
 * that window is the wrong trade — do not "fix" it that way.
 *
 * Child env comes from `withPersonaEnv`, the same helper every harness spawn
 * uses: it adds the engine-scope `XDG_*` roots plus the `PHANTOMBOT_ENGINE_SCOPE`
 * marker and drops host-location overrides, so a detached child in an embedding
 * app resolves that app's data home instead of the host's.
 *
 * @returns true when a refresh was spawned.
 */
export function syncPiModels(opts: {
  persona?: string;
  dataHome?: string;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: (cmd: string, args: string[], opts: object) => DetachedChild;
} = {}): boolean {
  const env = opts.env ?? process.env;
  const on = (v: string | undefined): boolean => !!v && !/^(0|false|no|off)$/i.test(v.trim());
  // Opted out by the caller/test, or pi is told to stay offline: a refresh could
  // only queue a request destined to fail.
  if (on(env[ENV_PI_MODELS_SYNC_OFF]) || on(env.PI_OFFLINE)) return false;
  const key = `${opts.dataHome ?? ""}\0${opts.persona ?? ""}`;
  if (piModelsSyncInFlight.has(key)) return false;

  try {
    const agentDir = nativeAgentDir(opts.dataHome, opts.persona);
    // Creating this dir is what makes a persona's first turn SKIP the legacy
    // absorb (absorbFileInto ignores existing targets), so on an upgraded host
    // a refresh-before-first-turn would silently strand the legacy catalog.
    // Let that persona's first real turn run ensureNativeAgentDir in its
    // intended order; a later Settings visit refreshes.
    if (opts.persona && !existsSync(agentDir) && existsSync(nativeAgentDir(opts.dataHome))) {
      return false;
    }
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    // Start from the ambient env (PATH/HOME must survive) and ADD the scope —
    // through the shared helper, not a raw copy, so the child resolves the same
    // roots as its parent (see the docstring).
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) if (typeof v === "string") childEnv[k] = v;
    const scoped = withPersonaEnv(childEnv, opts.persona);
    scoped[ENV_PI_AGENT_DIR] = agentDir;

    const cmd = embeddedPiCommand();
    const child = (opts.spawnImpl ?? (spawn as unknown as NonNullable<typeof opts.spawnImpl>))(
      cmd[0]!,
      [...cmd.slice(1), "update", "--models"],
      { detached: true, stdio: "ignore", windowsHide: true, env: scoped },
    );
    child.on("error", () => {
      // The child never started: clear the mark so a later Settings visit
      // retries instead of never refreshing again.
      piModelsSyncInFlight.delete(key);
    });
    child.unref();
    piModelsSyncInFlight.add(key);
    return true;
  } catch {
    // Best-effort: a failed catalog refresh is never fatal.
    return false;
  }
}

/**
 * The `__pi` entry: become the pi CLI for this process. Called from
 * src/index.ts before anything else loads.
 */
export async function runEmbeddedPi(args: string[]): Promise<void> {
  if (isCompiledBinary() && !process.env.PI_PACKAGE_DIR) {
    // Normally the harness already set this. A hand-run `phantombot __pi`
    // resolves the default data dir itself.
    const { xdgDataHome } = await import("../config.ts");
    process.env.PI_PACKAGE_DIR = ensureEmbeddedPiAssets(
      embeddedPiPackageDir(xdgDataHome()),
    ).dir;
  }
  if (!process.env[ENV_PHANTOMBOT_PI_COMMAND]) {
    process.env[ENV_PHANTOMBOT_PI_COMMAND] = JSON.stringify(embeddedPiCommand());
  }
  // ISOLATION for hand-runs too: `phantombot __pi` IS the embedded engine, so
  // it gets the same phantombot-owned agent dir the harness gives it (the
  // harness sets this per-spawn; a hand-run would otherwise fall back to the
  // user's ~/.pi). An explicit override wins. PER-PERSONA (lib/nativeAgentDir.ts):
  // a hand-run inside a persona's context (PHANTOMBOT_PERSONA set) resolves
  // that persona's own store; a bare hand-run gets the legacy host-level dir.
  if (!process.env[ENV_PI_AGENT_DIR]) {
    // nativeAgentEnv ensures (mkdir + legacy absorb) and returns the dir.
    const persona = process.env.PHANTOMBOT_PERSONA;
    process.env[ENV_PI_AGENT_DIR] = nativeAgentEnv(undefined, persona)[ENV_PI_AGENT_DIR];
  }
  // Pi reads process.argv in places besides the args it is handed; make it
  // look exactly like `pi <args>`.
  process.argv.splice(2, process.argv.length - 2, ...args);
  // Image support: photon's WASM path is baked to the build machine, so serve
  // it from the binary before pi can try to load it (see embeddedPhoton.ts).
  if (isCompiledBinary()) {
    const { installEmbeddedPhotonWasm } = await import("./embeddedPhoton.ts");
    installEmbeddedPhotonWasm();
  }
  const { setupCli } = await piDistModule("cli/setup.js");
  const { main } = await piDistModule("main.js");
  setupCli();
  await main(args, {
    extensionFactories: embeddedPiExtensionFactories() as never[],
  });
}

/**
 * Load one of pi's unbundled `dist/` entry modules (see fact 1 above).
 * Compiled: the literal specifiers are what the bundler inlines. From source:
 * the same file, located from pi's real package root.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function piDistModule(rel: "cli/setup.js" | "main.js"): Promise<any> {
  if (isCompiledBinary()) {
    return rel === "main.js"
      ? await import("../../node_modules/@earendil-works/pi-coding-agent/dist/main.js")
      : await import("../../node_modules/@earendil-works/pi-coding-agent/dist/cli/setup.js");
  }
  return await import(pathToFileURL(join(piPackageRoot(), "dist", rel)).href);
}
