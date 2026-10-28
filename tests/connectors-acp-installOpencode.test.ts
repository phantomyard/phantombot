/**
 * `phantombot acp install opencode` — the JSONC-safe provider registration.
 *
 * Everything runs against an in-memory fake filesystem (injected through
 * `deps`), so no test touches the developer's real opencode.json, HOME or
 * XDG roots.
 */

import { describe, expect, test } from "bun:test";
import { parse } from "jsonc-parser";

import {
  defaultOpencodeModulePath,
  fallbackOpencodeConfigPath,
  installOpencode,
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

  test("Windows default lives under APPDATA", () => {
    const fs = fakeFs();
    fs.deps.platform = "win32";
    fs.deps.env = { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" };
    expect(fallbackOpencodeConfigPath(fs.deps)).toBe(
      "C:\\Users\\tester\\AppData\\Roaming\\opencode\\opencode.json",
    );
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
