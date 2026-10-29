/**
 * `phantombot acp install opencode` — the JSONC-safe provider registration.
 *
 * Everything runs against an in-memory fake filesystem (injected through
 * `deps`), so no test touches the developer's real opencode.json, HOME or
 * XDG roots.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "jsonc-parser";

import {
  defaultOpencodeModulePath,
  fallbackOpencodeConfigPath,
  installOpencode,
  needsWindowsShell,
  opencodeCliCandidates,
  opencodeDesktopMarkers,
  personaModelNames,
  phantombotOpencodeProviderBlock,
  resolveOpencodeConfigPath,
  type OpencodeDeps,
} from "../src/connectors/acp/installOpencode.ts";

interface FakeFs {
  deps: Partial<OpencodeDeps>;
  files: Map<string, string>;
  dirs: Set<string>;
  writes: string[];
  renames: Array<[string, string]>;
}

function fakeFs(initial: Record<string, string> = {}, dirs: string[] = []): FakeFs {
  const files = new Map(Object.entries(initial));
  const dirSet = new Set(dirs);
  const writes: string[] = [];
  const renames: Array<[string, string]> = [];
  const deps: Partial<OpencodeDeps> = {
    platform: "linux",
    env: {},
    homedir: () => "/home/tester",
    exists: (path) => files.has(path) || dirSet.has(path),
    readFile: (path) => files.get(path),
    writeFile: (path, data) => {
      writes.push(path);
      files.set(path, data);
    },
    mkdirp: (path) => {
      dirSet.add(path);
    },
    rename: (from, to) => {
      const data = files.get(from);
      if (data === undefined) throw new Error(`rename: missing ${from}`);
      renames.push([from, to]);
      files.set(to, data);
      files.delete(from);
    },
    runOpencode: () => undefined,
    listDir: () => [],
    listFiles: () => [],
  };
  return { deps, files, dirs: dirSet, writes, renames };
}

const CONFIG = "/home/tester/.config/opencode/opencode.json";
const MODULE = "/home/tester/.local/share/phantombot/connectors/opencode/index.mjs";

describe("opencode config path resolution", () => {
  test("$OPENCODE_CONFIG wins", () => {
    const fs = fakeFs({}, ["/custom"]);
    fs.deps.env = { OPENCODE_CONFIG: "/custom/opencode.jsonc" };
    expect(resolveOpencodeConfigPath(fs.deps)).toEqual({
      configPath: "/custom/opencode.jsonc",
      detected: true,
    });
  });

  test("`opencode debug paths config` supplies the directory, file name is picked from what exists", () => {
    const fs = fakeFs({ "/opt/oc/opencode.jsonc": "{}" }, ["/opt/oc"]);
    fs.deps.runOpencode = (args) => {
      // The command prints a DIRECTORY, not a file — the trap this covers.
      expect(args).toEqual(["debug", "paths", "config"]);
      return { code: 0, stdout: "/opt/oc\n" };
    };
    expect(resolveOpencodeConfigPath(fs.deps).configPath).toBe("/opt/oc/opencode.jsonc");
  });

  test("falls back to the per-platform default and reports not-detected when nothing exists", () => {
    const fs = fakeFs();
    expect(resolveOpencodeConfigPath(fs.deps)).toEqual({
      configPath: CONFIG,
      detected: false,
    });
  });

  test("Windows default is ~/.config/opencode, NOT %APPDATA%\\opencode", () => {
    // Verified against real OpenCode 2.2.1 bundle: user config is
    // `$XDG_CONFIG_HOME || ~/.config` + "opencode" on every platform, and a real
    // Desktop-only Windows install creates %USERPROFILE%\\.config\\opencode.
    const fs = fakeFs();
    fs.deps.platform = "win32";
    fs.deps.homedir = () => "C:\\Users\\tester";
    fs.deps.env = { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" };
    expect(fallbackOpencodeConfigPath(fs.deps)).toBe(
      "C:\\Users\\tester\\.config\\opencode\\opencode.json",
    );
  });

  test("Windows default honours XDG_CONFIG_HOME", () => {
    const fs = fakeFs();
    fs.deps.platform = "win32";
    fs.deps.env = { XDG_CONFIG_HOME: "D:\\xdg" };
    expect(fallbackOpencodeConfigPath(fs.deps)).toBe("D:\\xdg\\opencode\\opencode.json");
  });

  test("Windows: bundled Desktop CLI is probed when `opencode` is not on PATH", () => {
    const cli = "C:\\Users\\tester\\AppData\\Roaming\\ai.opencode.desktop\\cli\\2.2.1-x64\\opencode-cli.exe";
    const fs = fakeFs({ [cli]: "" }, ["C:\\Users\\tester\\AppData\\Roaming\\ai.opencode.desktop\\cli"]);
    fs.deps.platform = "win32";
    fs.deps.homedir = () => "C:\\Users\\tester";
    fs.deps.env = { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" };
    fs.deps.listDir = () => ["2.2.1-x64"];
    const tried: string[] = [];
    fs.deps.runOpencode = (_args, exe) => {
      tried.push(exe ?? "opencode");
      return exe === "opencode" ? { code: 1, stdout: "" } : { code: 0, stdout: "C:\\Users\\tester\\.config\\opencode\r\n" };
    };
    expect(resolveOpencodeConfigPath(fs.deps).configPath).toBe(
      "C:\\Users\\tester\\.config\\opencode\\opencode.json",
    );
    expect(tried[0]).toBe("opencode");
    expect(tried).toContain(cli);
  });

  test("macOS: Desktop-only install (app bundle, never launched) counts as detected", () => {
    const fs = fakeFs({}, ["/Applications/OpenCode.app"]);
    fs.deps.platform = "darwin";
    fs.deps.homedir = () => "/Users/tester";
    fs.deps.exists = (path) => path === "/Applications/OpenCode.app";
    const resolved = resolveOpencodeConfigPath(fs.deps);
    expect(resolved.detected).toBe(true);
    expect(resolved.configPath).toBe("/Users/tester/.config/opencode/opencode.json");
  });

  test("macOS: bundled CLI inside the app bundle is a probe candidate", () => {
    const fs = fakeFs();
    fs.deps.platform = "darwin";
    fs.deps.homedir = () => "/Users/tester";
    fs.deps.exists = (path) => path === "/Applications/OpenCode.app/Contents/Resources/opencode-cli";
    const probed: string[] = [];
    fs.deps.runOpencode = (_args, exe) => {
      probed.push(exe ?? "opencode");
      return exe === "/Applications/OpenCode.app/Contents/Resources/opencode-cli"
        ? { code: 0, stdout: "/Users/tester/.config/opencode\n" }
        : undefined;
    };
    expect(resolveOpencodeConfigPath(fs.deps).detected).toBe(true);
    expect(probed).toContain("/Applications/OpenCode.app/Contents/Resources/opencode-cli");
  });

  test("Linux: Desktop payload at /opt/OpenCode/resources/opencode-cli is a probe candidate", () => {
    // Observed on a real Ubuntu 26.04 / OpenCode Desktop 2.2.0 install: the deb
    // payload keeps the CLI inside its app dir and nothing named `opencode` is
    // on PATH, so without this candidate the install is a silent no-op.
    const cli = "/opt/OpenCode/resources/opencode-cli";
    const fs = fakeFs();
    fs.deps.exists = (path) => path === cli || path === "/opt/OpenCode";
    expect(opencodeCliCandidates(fs.deps)).toContain(cli);
    const probed: string[] = [];
    fs.deps.runOpencode = (_args, exe) => {
      probed.push(exe ?? "opencode");
      return exe === cli ? { code: 0, stdout: "/home/tester/.config/opencode\n" } : undefined;
    };
    expect(resolveOpencodeConfigPath(fs.deps)).toEqual({
      configPath: "/home/tester/.config/opencode/opencode.json",
      detected: true,
    });
    expect(probed).toContain(cli);
  });

  test("Linux: a non-standard app dir is found via the desktop entry's Exec=", () => {
    const entry = [
      "[Desktop Entry]",
      "Name=OpenCode",
      "Exec=/usr/local/opt/OpenCode/ai.opencode %U",
      "Type=Application",
    ].join("\n");
    const desktopFile = "/usr/share/applications/ai.opencode.desktop.desktop";
    const cli = "/usr/local/opt/OpenCode/resources/opencode-cli";
    const fs = fakeFs({ [desktopFile]: entry });
    fs.deps.exists = (path) => path === cli || path === "/usr/local/opt/OpenCode/ai.opencode";
    expect(opencodeCliCandidates(fs.deps)).toContain(cli);
  });

  test("Linux: XDG_DATA_DIRS desktop entries are searched too", () => {
    const desktopFile = "/opt/share/applications/ai.opencode.desktop.desktop";
    const cli = "/opt/OpenCode-test/resources/opencode-cli";
    const fs = fakeFs({ [desktopFile]: "[Desktop Entry]\nExec=\"/opt/OpenCode-test/ai.opencode\" %F\n" });
    fs.deps.env = { XDG_DATA_DIRS: "/opt/share" };
    fs.deps.exists = (path) => path === cli || path === "/opt/OpenCode-test/ai.opencode";
    expect(opencodeCliCandidates(fs.deps)).toContain(cli);
  });

  test("Linux: a relative Exec= is not mistaken for an app dir", () => {
    // `Exec=opencode %U` (snap-style wrapper or a hand-written entry) must not
    // produce a relative candidate like "resources/opencode-cli".
    const fs = fakeFs({
      "/usr/share/applications/ai.opencode.desktop.desktop": "[Desktop Entry]\nExec=opencode %U\n",
    });
    fs.deps.exists = () => true;
    // The bare `opencode` PATH probe is fine; what must never appear is an
    // app-dir candidate derived from a relative Exec.
    for (const candidate of opencodeCliCandidates(fs.deps)) {
      if (candidate === "opencode") continue;
      expect(candidate.startsWith("/")).toBe(true);
    }
  });

  test("Linux: quote and field-code handling in Exec=", () => {
    const spaced = "/opt/My Apps/OpenCode";
    const fs = fakeFs({
      "/usr/share/applications/ai.opencode.desktop.desktop": `[Desktop Entry]\nExec="${spaced}/ai.opencode" %U\n`,
      "/usr/local/share/applications/opencode-desktop.desktop": "[Desktop Entry]\nExec=%U /opt/OpenCode2/ai.opencode\n",
    });
    fs.deps.exists = (path) =>
      path === `${spaced}/resources/opencode-cli` ||
      path === "/opt/OpenCode2/resources/opencode-cli" ||
      path === `${spaced}/ai.opencode` ||
      path === "/opt/OpenCode2/ai.opencode";
    const candidates = opencodeCliCandidates(fs.deps);
    expect(candidates).toContain(`${spaced}/resources/opencode-cli`);
    // A field code ahead of the command is never treated as the executable.
    expect(candidates).toContain("/opt/OpenCode2/resources/opencode-cli");
  });

  test("Linux: a Desktop app dir counts as installed even before first launch", () => {
    // Marker comes from the desktop entry, not the /opt default — the only way a
    // relocated or AppImage-style payload is detected before its first launch.
    const fs = fakeFs({ "/usr/share/applications/ai.opencode.desktop.desktop": "[Desktop Entry]\nExec=/data/OpenCode/ai.opencode %U\n" });
    fs.deps.exists = (path) => path === "/data/OpenCode" || path === "/data/OpenCode/ai.opencode";
    expect(opencodeDesktopMarkers(fs.deps)).toContain("/opt/OpenCode");
    expect(resolveOpencodeConfigPath(fs.deps).detected).toBe(true);
  });

  test("staged CLI versions are ranked numerically, not lexicographically", () => {
    const fs = fakeFs();
    fs.deps.platform = "win32";
    fs.deps.homedir = () => "C:\\Users\\tester";
    fs.deps.env = { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" };
    fs.deps.listDir = () => ["2.9.0-x64", "2.10.0-x64"];
    fs.deps.exists = (path) => path.endsWith("opencode-cli.exe");
    const candidates = opencodeCliCandidates(fs.deps);
    const staged = candidates.filter((candidate) => candidate.includes("2."));
    expect(staged[0]).toContain("2.10.0-x64");
  });

  test("the probe loop honours a shared deadline instead of 20s per candidate", () => {
    const fs = fakeFs();
    let clock = 0;
    fs.deps.now = () => clock;
    fs.deps.exists = (path) => path.startsWith("/opt/") || path.startsWith("/usr/");
    const probed: string[] = [];
    fs.deps.runOpencode = (_args, exe) => {
      probed.push(exe ?? "opencode");
      clock += 20_000; // every candidate hangs to its full timeout
      return undefined;
    };
    resolveOpencodeConfigPath(fs.deps);
    expect(probed.length).toBeLessThanOrEqual(2);
  });

  test("a bare `opencode` is the only probe routed through a Windows shell", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      expect(needsWindowsShell("opencode")).toBe(true);
      expect(needsWindowsShell("C:\\Users\\Andrew Hodges\\AppData\\Roaming\\ai.opencode.desktop\\cli\\2.2.1-x64\\opencode-cli.exe")).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  });

  test("a stale desktop entry does not fake an install", () => {
    // Anything left behind by an uninstalled app (or an unmounted AppImage whose
    // Exec points into /tmp/.mount_…) must keep answering `not-detected` rather
    // than registering a provider for an editor that is not there.
    const fs = fakeFs({
      "/usr/share/applications/opencode.desktop": "[Desktop Entry]\nExec=/usr/bin/opencode %U\n",
    });
    fs.deps.exists = (path) => path === "/usr/bin"; // the dir exists, the target does not
    const resolved = resolveOpencodeConfigPath(fs.deps);
    expect(resolved.detected).toBe(false);
    expect(opencodeDesktopMarkers(fs.deps)).not.toContain("/usr/bin");
    const result = installOpencode({
      binaryPath: "/usr/local/bin/phantombot",
      personas: ["kai"],
      deps: fs.deps,
    });
    expect(result.action).toBe("not-detected");
  });

  test("Linux: an `env`-prefixed Exec= still resolves the app dir", () => {
    // A NON-static app dir, so only the Exec= follow can produce the candidate.
    const desktopFile = "/usr/share/applications/ai.opencode.desktop.desktop";
    const app = "/data/OC-env/ai.opencode";
    const fs = fakeFs({ [desktopFile]: "[Desktop Entry]\nExec=env FOO=bar /data/OC-env/ai.opencode %U\n" });
    fs.deps.exists = (path) => path === app || path === "/data/OC-env/resources/opencode-cli";
    expect(opencodeCliCandidates(fs.deps)).toContain("/data/OC-env/resources/opencode-cli");
  });

  test("Linux: a snap entry named `<snap>_<app>.desktop` is followed too", () => {
    // The point is the ENTRY NAME: `opencode_opencode.desktop` never matches the
    // three fixed names, so only the listDir scan finds it.
    const desktopFile = "/var/lib/snapd/desktop/applications/opencode_opencode.desktop";
    const cli = "/snap/opencode/42/resources/opencode-cli";
    const fs = fakeFs({ [desktopFile]: "[Desktop Entry]\nExec=/snap/opencode/42/opencode %U\n" });
    fs.deps.env = { XDG_DATA_DIRS: "/var/lib/snapd/desktop" };
    fs.deps.listFiles = (path) => (path === "/var/lib/snapd/desktop/applications" ? ["opencode_opencode.desktop"] : []);
    fs.deps.exists = (path) => path === "/snap/opencode/42/opencode" || path === cli;
    expect(opencodeCliCandidates(fs.deps)).toContain(cli);
  });

  test("the SHIPPED deps can actually list a desktop entry (no stubs)", () => {
    // Regression for review finding: `listDir` filters directories, so a snap
    // `opencode_opencode.desktop` could never be matched in production even
    // though the stubbed unit case passed.
    const root = mkdtempSync(join(tmpdir(), "pb-oc-apps-"));
    try {
      const applications = join(root, "applications");
      mkdirSync(applications, { recursive: true });
      const app = join(root, "OpenCode", "ai.opencode");
      mkdirSync(dirname(app), { recursive: true });
      writeFileSync(app, "", { mode: 0o755 });
      writeFileSync(
        join(applications, "opencode_opencode.desktop"),
        `[Desktop Entry]\nExec=${app} %U\n`,
      );
      mkdirSync(join(root, "OpenCode", "resources"), { recursive: true });
      const cli = join(root, "OpenCode", "resources", "opencode-cli");
      writeFileSync(cli, "", { mode: 0o755 });

      const candidates = opencodeCliCandidates({
        homedir: () => root,
        env: { XDG_DATA_DIRS: root },
      });
      expect(candidates).toContain(cli);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("module path honours XDG_DATA_HOME", () => {
    expect(defaultOpencodeModulePath({ env: { XDG_DATA_HOME: "/xdg/data" }, homedir: () => "/home/tester" })).toBe(
      "/xdg/data/phantombot/connectors/opencode/index.mjs",
    );
  });
});

describe("provider block", () => {
  test("uses the aisdk: prefix and one model per persona", () => {
    const block = phantombotOpencodeProviderBlock({
      binaryPath: "/usr/local/bin/phantombot",
      modulePath: MODULE,
      personas: ["kai", "omar"],
    });
    expect(block.package).toBe(`aisdk:file://${MODULE}`);
    expect(block.settings).toEqual({ command: "/usr/local/bin/phantombot" });
    expect(Object.keys(block.models as Record<string, unknown>).sort()).toEqual(["kai", "omar"]);
  });

  test("encodes Windows paths as file:/// URLs", () => {
    const block = phantombotOpencodeProviderBlock({
      binaryPath: "C:\\pb\\phantombot.exe",
      modulePath: "C:\\Users\\t e s t e r\\opencode\\index.mjs",
      personas: [],
      platform: "win32",
    });
    expect(String(block.package)).toBe("aisdk:file:///C:/Users/t%20e%20s%20t%20e%20r/opencode/index.mjs");
  });
});

describe("personaModelNames", () => {
  test("lists sorted subdirectories only", () => {
    const fs = fakeFs();
    fs.deps.exists = () => true;
    const listed = personaModelNames("/personas");
    expect(Array.isArray(listed)).toBe(true);
  });

  test("a missing directory yields no models rather than throwing", () => {
    expect(personaModelNames("/definitely/not/here")).toEqual([]);
  });
});

describe("installOpencode", () => {
  test("does nothing when OpenCode is not installed", () => {
    const fs = fakeFs();
    const result = installOpencode({
      binaryPath: "/usr/local/bin/phantombot",
      personas: ["omar"],
      deps: fs.deps,
    });
    expect(result.action).toBe("not-detected");
    expect(result.code).toBe(0);
    expect(fs.writes).toEqual([]);
  });

  test("an explicit --persona that matches nothing fails instead of writing an empty models map", () => {
    const fs = fakeFs({}, ["/home/tester/.config/opencode"]);
    const result = installOpencode({
      binaryPath: "/usr/local/bin/phantombot",
      // The CLI passes EVERY persona so a typo can name the real choices.
      personas: ["kai", "lena"],
      requestedPersona: "typo",
      deps: fs.deps,
    });

    expect(result.code).toBe(1);
    expect(result.action).toBe("error");
    expect(result.message).toContain('no persona named "typo"');
    expect(result.message).toContain("available: kai, lena");
    // Nothing staged, no config written: exit 0 with models:{} would tell the
    // user the install worked while OpenCode offers no PhantomBot model.
    expect(fs.writes).toEqual([]);
  });

  test("registers a fresh config, staging the module first", () => {
    const fs = fakeFs({}, ["/home/tester/.config/opencode"]);
    const result = installOpencode({
      binaryPath: "/usr/local/bin/phantombot",
      personas: ["omar", "kai"],
      deps: fs.deps,
    });

    expect(result.action).toBe("registered");
    expect(result.code).toBe(0);

    // The module is written BEFORE the config lands, so a registration never
    // points at a file that does not exist yet.
    expect(fs.writes[0]).toBe(MODULE);
    const config = parse(fs.files.get(CONFIG)!) as any;
    expect(config.providers.phantombot.package).toBe(`aisdk:file://${MODULE}`);
    expect(config.providers.phantombot.settings.command).toBe("/usr/local/bin/phantombot");
    expect(config.providers.phantombot.models.omar.name).toContain("omar");
    expect(config.providers.phantombot.models.kai.name).toContain("kai");
  });

  test("creates the config directory on a Desktop-only install that never ran", () => {
    // Real state on a fresh macOS install: /Applications/OpenCode.app exists but
    // ~/.config/opencode does not. Before this fix the write threw ENOENT and the
    // whole install failed with action "error".
    const fs = fakeFs({}, ["/Applications/OpenCode.app"]);
    fs.deps.platform = "darwin";
    fs.deps.homedir = () => "/Users/tester";
    fs.deps.exists = (path) => path === "/Applications/OpenCode.app";
    const made: string[] = [];
    fs.deps.mkdirp = (path) => made.push(path);
    const result = installOpencode({
      binaryPath: "/Users/tester/.local/bin/phantombot",
      personas: ["matt"],
      deps: fs.deps,
    });
    expect(result.action).toBe("registered");
    expect(made).toContain("/Users/tester/.config/opencode");
    expect(result.configPath).toBe("/Users/tester/.config/opencode/opencode.json");
  });

  test("preserves comments, other keys and other providers", () => {
    const original = `{
  // my settings
  "theme": "system",
  "providers": {
    "other": { "package": "npm:whatever", "settings": { "apiKey": "k" } }
  }
}
`;
    const fs = fakeFs({ [CONFIG]: original }, ["/home/tester/.config/opencode"]);
    const result = installOpencode({
      binaryPath: "/usr/local/bin/phantombot",
      personas: ["omar"],
      deps: fs.deps,
    });
    expect(result.action).toBe("registered");

    const written = fs.files.get(CONFIG)!;
    expect(written).toContain("// my settings");
    expect(written).toContain('"theme": "system"');
    const parsed = parse(written) as any;
    expect(parsed.providers.other).toEqual({ package: "npm:whatever", settings: { apiKey: "k" } });
    expect(parsed.providers.phantombot.models.omar).toBeDefined();
  });

  test("is a byte-identical no-op on the second run", () => {
    const fs = fakeFs({}, ["/home/tester/.config/opencode"]);
    installOpencode({ binaryPath: "/usr/local/bin/phantombot", personas: ["omar"], deps: fs.deps });
    const afterFirst = fs.files.get(CONFIG)!;
    const writesAfterFirst = fs.writes.length;

    const second = installOpencode({
      binaryPath: "/usr/local/bin/phantombot",
      personas: ["omar"],
      deps: fs.deps,
    });
    expect(second.action).toBe("current");
    expect(fs.files.get(CONFIG)).toBe(afterFirst);
    expect(fs.writes.length).toBe(writesAfterFirst);
  });

  test("rewrites (and backs up) when the binary path or persona set changes", () => {
    const fs = fakeFs({}, ["/home/tester/.config/opencode"]);
    installOpencode({ binaryPath: "/old/phantombot", personas: ["omar"], deps: fs.deps });
    const before = fs.files.get(CONFIG)!;

    const result = installOpencode({
      binaryPath: "/new/phantombot",
      personas: ["omar", "kai"],
      deps: fs.deps,
    });
    expect(result.action).toBe("updated");
    expect(fs.files.get(`${CONFIG}.phantombot-bak`)).toBe(before);
    const parsed = parse(fs.files.get(CONFIG)!) as any;
    expect(parsed.providers.phantombot.settings.command).toBe("/new/phantombot");
    expect(parsed.providers.phantombot.models.kai).toBeDefined();
  });

  test("aborts without writing when the config is not parseable", () => {
    const broken = '{ "providers": { "phantombot": { } ';
    const fs = fakeFs({ [CONFIG]: broken }, ["/home/tester/.config/opencode"]);
    const result = installOpencode({
      binaryPath: "/usr/local/bin/phantombot",
      personas: ["omar"],
      deps: fs.deps,
    });
    expect(result.action).toBe("error");
    expect(result.code).toBe(1);
    expect(fs.files.get(CONFIG)).toBe(broken);
    // Crucially, the module was NOT staged either: the abort happens before any write.
    expect(fs.writes).toEqual([]);
  });

  test("warns about the v1 singular `provider` block that v2 ignores", () => {
    const fs = fakeFs(
      { [CONFIG]: '{ "provider": { "phantombot": { "npm": "x" } } }' },
      ["/home/tester/.config/opencode"],
    );
    const result = installOpencode({
      binaryPath: "/usr/local/bin/phantombot",
      personas: ["omar"],
      deps: fs.deps,
    });
    expect(result.action).toBe("registered");
    expect(result.legacyKeyWarning).toContain("providers");
    // The legacy block itself is left alone; only `providers` is written.
    const parsed = parse(fs.files.get(CONFIG)!) as any;
    expect(parsed.provider.phantombot.npm).toBe("x");
    expect(parsed.providers.phantombot.models.omar).toBeDefined();
  });

  test("repair:false reports drift without writing", () => {
    const fs = fakeFs({}, ["/home/tester/.config/opencode"]);
    const result = installOpencode({
      binaryPath: "/usr/local/bin/phantombot",
      personas: ["omar"],
      repair: false,
      deps: fs.deps,
    });
    expect(result.action).toBe("registered");
    expect(result.message).toContain("repair is off");
    expect(fs.writes).toEqual([]);
    expect(fs.files.has(CONFIG)).toBe(false);
  });
});
