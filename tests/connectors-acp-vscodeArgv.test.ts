/**
 * `~/.vscode/argv.json` proposed-API allow-list — pure, no real VS Code, no
 * real `$HOME`, nothing written outside an in-memory fake fs.
 *
 * The file under test is the data-loss-sensitive one: argv.json ships from VS
 * Code full of comments and carries the user's `crash-reporter-id`. Losing it
 * is worse than never enabling the proposed APIs at all, so the abort-on-
 * unparseable path and the comment/key preservation paths get first-class
 * coverage — the same guarantees installZed.ts makes for settings.json.
 */

import { describe, expect, test } from "bun:test";
import { parse } from "jsonc-parser";

import {
  checkProposedApi,
  defaultVscodeArgvPath,
  ENABLE_PROPOSED_API_KEY,
  ensureProposedApi,
  planProposedApi,
  vscodeDataFolderName,
  type ArgvDeps,
} from "../src/connectors/acp/vscodeArgv.ts";

const EXT = "phantomyard.phantombot-vscode";
const ARGV = "/fake/home/.vscode/argv.json";

/** In-memory fs seam. `undefined` initial contents ⇒ the file doesn't exist. */
function makeDeps(initial?: string) {
  const files = new Map<string, string>();
  if (initial !== undefined) files.set(ARGV, initial);
  const writes: string[] = [];
  const deps: ArgvDeps = {
    argvPath: ARGV,
    read: (p) => files.get(p),
    write: (p, contents) => {
      writes.push(p);
      files.set(p, contents);
    },
  };
  return { deps, files, writes };
}

/** VS Code's stock argv.json, comments and all. */
const STOCK = `// This configuration file allows you to pass permanent command line arguments to VS Code.
//
// PLEASE DO NOT CHANGE WITHOUT UNDERSTANDING THE IMPACT
{
	// Allows to disable crash reporting.
	"enable-crash-reporter": true,

	// Unique id used for correlating crash reports sent from this instance.
	// Do not edit this value.
	"crash-reporter-id": "71e7281d-a073-4285-8a37-7581b7168042"
}`;

/** Path segments, split on either separator, so `.vscode` can be matched EXACTLY. */
function segments(p: string): string[] {
  return p.split(/[\\/]/);
}

describe("defaultVscodeArgvPath", () => {
  test("is <home>/.vscode/argv.json — no APPDATA/XDG branch", () => {
    // Unlike settings.json, VS Code derives argv.json from os.homedir() on
    // every platform. Getting this wrong = writing a file VS Code never reads.
    // Verified on the real Windows box: C:\Users\<user>\.vscode\argv.json,
    // carrying VS Code's own header comments and crash-reporter-id.
    const p = defaultVscodeArgvPath();
    expect(p.endsWith("argv.json")).toBe(true);
    // Exact segment, not `includes(".vscode")` — that substring also matches
    // `.vscode-insiders`, so the loose form would pass for the wrong folder.
    expect(segments(p)).toContain(".vscode");
  });
});

describe("vscodeDataFolderName", () => {
  // Kai's review asked for Windows coverage. The value of these cases is that
  // they run on LINUX CI: a node:path.basename() implementation passes on
  // Windows and fails here — that asymmetry is how the phantombot.exe gate
  // shipped in the first place.
  test("stable resolves to .vscode on every platform and path shape", () => {
    for (const cli of [
      undefined,
      "code",
      "code.cmd",
      "/usr/bin/code",
      "/snap/bin/code",
      "C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd",
      "C:\\Program Files (x86)\\Microsoft VS Code\\bin\\CODE.CMD",
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    ]) {
      expect(vscodeDataFolderName(cli)).toBe(".vscode");
    }
  });

  test("a Windows CLI path is split on backslashes, not swallowed whole", () => {
    // The whole point: node:path.basename does NOT split `\` under POSIX.
    expect(
      vscodeDataFolderName(
        "C:\\Program Files\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd",
      ),
    ).toBe(".vscode-insiders");
  });

  test("distributions get their own data folder, never stable's", () => {
    expect(vscodeDataFolderName("code-insiders")).toBe(".vscode-insiders");
    expect(vscodeDataFolderName("/usr/bin/code-insiders")).toBe(".vscode-insiders");
    expect(vscodeDataFolderName("codium")).toBe(".vscode-oss");
    expect(vscodeDataFolderName("/usr/bin/vscodium")).toBe(".vscode-oss");
  });

  test("an unknown CLI falls back to stable rather than inventing a folder", () => {
    expect(vscodeDataFolderName("cursor")).toBe(".vscode");
    expect(vscodeDataFolderName("/opt/weird/editor.exe")).toBe(".vscode");
  });

  test("defaultVscodeArgvPath follows the derived folder", () => {
    expect(segments(defaultVscodeArgvPath("code-insiders"))).toContain(
      ".vscode-insiders",
    );
    expect(segments(defaultVscodeArgvPath("code-insiders"))).not.toContain(".vscode");
    expect(segments(defaultVscodeArgvPath("codium"))).toContain(".vscode-oss");
  });
});

describe("planProposedApi", () => {
  test("absent file ⇒ create one carrying only our key", () => {
    const plan = planProposedApi(undefined, EXT);
    expect(plan.kind).toBe("write");
    if (plan.kind !== "write") throw new Error("unreachable");
    expect(parse(plan.updated)[ENABLE_PROPOSED_API_KEY]).toEqual([EXT]);
    // Explains itself to whoever opens the file next.
    expect(plan.updated).toContain("phantombot");
  });

  test("id already present ⇒ current, so startup never churns a backup", () => {
    const existing = `{"${ENABLE_PROPOSED_API_KEY}": ["${EXT}"]}`;
    expect(planProposedApi(existing, EXT).kind).toBe("current");
  });

  test("unparseable ⇒ abort; NEVER overwrite the user's file", () => {
    expect(planProposedApi("{ this is not json", EXT).kind).toBe("unparseable");
  });

  test("stock argv.json ⇒ merge, preserving comments and every other key", () => {
    const plan = planProposedApi(STOCK, EXT);
    expect(plan.kind).toBe("write");
    if (plan.kind !== "write") throw new Error("unreachable");

    const parsed = parse(plan.updated);
    expect(parsed[ENABLE_PROPOSED_API_KEY]).toEqual([EXT]);
    // The precious bits survive verbatim.
    expect(parsed["crash-reporter-id"]).toBe(
      "71e7281d-a073-4285-8a37-7581b7168042",
    );
    expect(parsed["enable-crash-reporter"]).toBe(true);
    expect(plan.updated).toContain("PLEASE DO NOT CHANGE WITHOUT UNDERSTANDING");
    expect(plan.updated).toContain("Do not edit this value.");
  });

  test("appends to an existing array — other extensions keep their access", () => {
    const existing = `{"${ENABLE_PROPOSED_API_KEY}": ["someone.else"]}`;
    const plan = planProposedApi(existing, EXT);
    if (plan.kind !== "write") throw new Error("expected write");
    expect(parse(plan.updated)[ENABLE_PROPOSED_API_KEY]).toEqual([
      "someone.else",
      EXT,
    ]);
  });

  test("trailing commas are tolerated, not treated as corruption", () => {
    const existing = `{\n  "enable-crash-reporter": true,\n}`;
    const plan = planProposedApi(existing, EXT);
    if (plan.kind !== "write") throw new Error("expected write");
    expect(parse(plan.updated)[ENABLE_PROPOSED_API_KEY]).toEqual([EXT]);
  });

  test("a non-array value is replaced, not appended to", () => {
    // Appending to a scalar would emit a file VS Code rejects outright, which
    // is a worse outcome than dropping one malformed value.
    const existing = `{"${ENABLE_PROPOSED_API_KEY}": "oops"}`;
    const plan = planProposedApi(existing, EXT);
    if (plan.kind !== "write") throw new Error("expected write");
    expect(parse(plan.updated)[ENABLE_PROPOSED_API_KEY]).toEqual([EXT]);
  });
});

describe("ensureProposedApi", () => {
  test("writes the entry and backs the original up first", () => {
    const { deps, files, writes } = makeDeps(STOCK);
    const r = ensureProposedApi({ deps, extensionId: EXT });

    expect(r.status).toBe("enabled");
    expect(r.backupPath).toBe(`${ARGV}.phantombot-bak`);
    // Backup written BEFORE the real file — order matters if we crash between.
    expect(writes).toEqual([`${ARGV}.phantombot-bak`, ARGV]);
    expect(files.get(`${ARGV}.phantombot-bak`)).toBe(STOCK);
    expect(parse(files.get(ARGV)!)[ENABLE_PROPOSED_API_KEY]).toEqual([EXT]);
  });

  test("is idempotent — a second run writes nothing at all", () => {
    const { deps } = makeDeps(STOCK);
    ensureProposedApi({ deps, extensionId: EXT });
    const { deps: d2, writes } = makeDeps(
      `{"${ENABLE_PROPOSED_API_KEY}": ["${EXT}"]}`,
    );
    const r = ensureProposedApi({ deps: d2, extensionId: EXT });
    expect(r.status).toBe("current");
    expect(r.backupPath).toBeUndefined();
    expect(writes).toEqual([]);
  });

  test("absent file ⇒ creates it, with no backup to make", () => {
    const { deps, files, writes } = makeDeps();
    const r = ensureProposedApi({ deps, extensionId: EXT });
    expect(r.status).toBe("enabled");
    expect(r.backupPath).toBeUndefined();
    expect(writes).toEqual([ARGV]);
    expect(parse(files.get(ARGV)!)[ENABLE_PROPOSED_API_KEY]).toEqual([EXT]);
  });

  test("unparseable ⇒ error, and the file is left byte-identical", () => {
    const garbage = "{ not json at all";
    const { deps, files, writes } = makeDeps(garbage);
    const r = ensureProposedApi({ deps, extensionId: EXT });
    expect(r.status).toBe("error");
    expect(r.error).toContain("refusing to touch it");
    expect(writes).toEqual([]);
    expect(files.get(ARGV)).toBe(garbage);
  });

  test("a throwing fs never escapes — startup must survive a bad disk", () => {
    const deps: ArgvDeps = {
      argvPath: ARGV,
      read: () => {
        throw new Error("EACCES");
      },
      write: () => {},
    };
    const r = ensureProposedApi({ deps, extensionId: EXT });
    expect(r.status).toBe("error");
    expect(r.error).toBe("EACCES");
  });

  test("a throwing write never escapes either", () => {
    const deps: ArgvDeps = {
      argvPath: ARGV,
      read: () => STOCK,
      write: () => {
        throw new Error("ENOSPC");
      },
    };
    const r = ensureProposedApi({ deps, extensionId: EXT });
    expect(r.status).toBe("error");
    expect(r.error).toBe("ENOSPC");
  });
});

describe("checkProposedApi (doctor --no-repair)", () => {
  test("never writes, even when the entry is missing", () => {
    const { deps, files, writes } = makeDeps(STOCK);
    const r = checkProposedApi({ deps, extensionId: EXT });
    expect(r.status).toBe("stale");
    expect(writes).toEqual([]);
    expect(files.get(ARGV)).toBe(STOCK);
  });

  test("never creates the file when it is absent", () => {
    const { deps, files, writes } = makeDeps();
    expect(checkProposedApi({ deps, extensionId: EXT }).status).toBe("stale");
    expect(writes).toEqual([]);
    expect(files.has(ARGV)).toBe(false);
  });

  test("reports current when already allow-listed", () => {
    const { deps } = makeDeps(`{"${ENABLE_PROPOSED_API_KEY}": ["${EXT}"]}`);
    expect(checkProposedApi({ deps, extensionId: EXT }).status).toBe("current");
  });

  test("reports error on an unparseable file", () => {
    const { deps } = makeDeps("{ nope");
    const r = checkProposedApi({ deps, extensionId: EXT });
    expect(r.status).toBe("error");
    expect(r.error).toContain("not parseable");
  });
});
