/**
 * VS Code `argv.json` writer — opts our side-loaded extension into the chat
 * proposed APIs it declares.
 *
 * WHY THIS IS NEEDED. `editors/vscode/package.json` declares
 * `enabledApiProposals: [chatSessionsProvider, chatParticipantPrivate,
 * chatReferenceBinaryData]`. Stable VS Code refuses proposed APIs to any
 * extension that isn't explicitly allow-listed, and for a SIDE-LOADED extension
 * (ours is installed from a bundled .vsix, never from the marketplace) the only
 * supported allow-list on stable is the `enable-proposed-api` array in the
 * per-user `~/.vscode/argv.json`.
 *
 * Without it the extension still loads, but `chatSessionsProvider` is
 * unavailable and it silently degrades to the `@phantombot` chat-participant
 * fallback (see sessionProvider.ts). That fallback is deliberate, which is
 * exactly what makes the missing entry so hard to spot: the panel looks
 * half-working rather than broken. Nothing in the repo ever wrote this file, so
 * every install has been landing in the degraded mode unless the user added the
 * entry by hand.
 *
 * DATA-LOSS-PROOF PROCEDURE — identical to installZed.ts, and non-negotiable.
 * `argv.json` ships from VS Code full of explanatory comments and carries the
 * user's `crash-reporter-id`, so it is JSONC and it is precious:
 *   1. Read the existing file.
 *   2. Parse with jsonc-parser (tolerant of comments + trailing commas).
 *   3. If the parse FAILS ⇒ ABORT. Write nothing, report `error`. NEVER "start
 *      fresh", NEVER overwrite.
 *   4. Otherwise merge our extension id into `enable-proposed-api` via
 *      modify/applyEdits, so every other key, every comment, and the file's
 *      formatting survive untouched.
 *   5. Back up the original, then write atomically (temp file + rename).
 *
 * Idempotent: when the id is already in the array we return `current` and touch
 * nothing, so this can run on every daemon startup without churning backups.
 *
 * Never throws. Every entry point returns a status.
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

import { VSCODE_EXTENSION_ID } from "../../lib/vscodeExtensionAsset.generated.ts";

/** The `enable-proposed-api` key VS Code reads out of argv.json. */
export const ENABLE_PROPOSED_API_KEY = "enable-proposed-api";

export type ProposedApiStatus =
  /** Extension id already allow-listed — nothing written. */
  | "current"
  /** We added the id (repair mode). VS Code must restart to pick it up. */
  | "enabled"
  /** Missing, and repair was off — reported, not written. */
  | "stale"
  /** Unparseable argv.json, or a filesystem failure. Nothing written. */
  | "error";

export interface ProposedApiResult {
  status: ProposedApiStatus;
  argvPath: string;
  backupPath?: string;
  /** Populated when `status === "error"`. */
  error?: string;
}

/**
 * Impure seams, injected so the whole merge runs under `bun test` against an
 * in-memory file with no real VS Code and no real `$HOME`.
 */
export interface ArgvDeps {
  argvPath: string;
  /** File contents, or undefined when the file does not exist. */
  read(path: string): string | undefined;
  /** Write `contents` to `path` atomically, creating parent dirs. */
  write(path: string, contents: string): void;
}

/**
 * Basename of a CLI path, split on BOTH separators and stripped of a Windows
 * launcher extension.
 *
 * `node:path`'s `basename` is platform-bound: on POSIX it does not treat `\` as
 * a separator, so `basename("C:\\...\\bin\\code.cmd")` returns the WHOLE
 * string. Deriving the data folder with it would therefore work on Windows and
 * silently misbehave under a Linux CI run of the Windows test — the exact class
 * of bug that let the `phantombot.exe` gate ship. Split on both, always.
 */
function cliBasename(cliPath: string): string {
  const tail = cliPath.split(/[\\/]/).pop() ?? cliPath;
  return tail.replace(/\.(cmd|exe|bat)$/i, "").toLowerCase();
}

/**
 * VS Code's per-user data folder, derived from the resolved CLI.
 *
 * Each distribution stamps its own `dataFolderName` into product.json, and
 * argv.json lives inside it. Hardcoding `.vscode` writes STABLE's runtime args
 * no matter which distribution we actually installed the extension into.
 *
 * Today `resolveCodeCli()` only ever resolves stable (`code` / `code.cmd`), so
 * every branch below except the first is unreachable in production. It exists
 * so the two can't silently disagree the moment someone adds Insiders to the
 * resolver — which is exactly how the extension would end up installed in one
 * editor and allow-listed in another.
 *
 * Unknown names fall back to stable rather than inventing a folder: writing
 * stable's argv.json is a visible no-op, creating a phantom data folder for an
 * editor that doesn't exist is litter.
 */
export function vscodeDataFolderName(codeCommand?: string): string {
  if (!codeCommand) return ".vscode";
  switch (cliBasename(codeCommand)) {
    case "code-insiders":
      return ".vscode-insiders";
    // VSCodium and OSS builds ship dataFolderName `.vscode-oss`.
    case "codium":
    case "vscodium":
      return ".vscode-oss";
    default:
      return ".vscode";
  }
}

/**
 * Resolve the per-user VS Code `argv.json` for the distribution behind
 * `codeCommand` (omit it for stable).
 *
 * It lives at `<home>/<dataFolder>/argv.json` on EVERY platform — VS Code
 * derives it from `os.homedir()` + its `dataFolderName`, so unlike
 * settings.json there is no `%APPDATA%` branch on Windows and no XDG lookup on
 * Linux. Verified directly on the Windows box: `C:\Users\<user>\.vscode\argv.json`,
 * carrying VS Code's own generated header comments and `crash-reporter-id`.
 *
 * argv.json holds GLOBAL runtime arguments, so it is not per-profile either.
 */
export function defaultVscodeArgvPath(codeCommand?: string): string {
  return join(homedir(), vscodeDataFolderName(codeCommand), "argv.json");
}

/** What a reconcile WOULD do to `existing`, computed purely. */
export type ArgvPlan =
  | { kind: "current" }
  | { kind: "unparseable" }
  | { kind: "write"; updated: string };

/**
 * Decide how to bring `existing` (undefined = file absent) in line with
 * `extensionId` being allow-listed. Pure — no I/O, so every branch is testable.
 *
 * A pre-existing `enable-proposed-api` that is NOT an array (a user typo, or
 * VS Code's own commented-out scalar example uncommented wrong) is replaced
 * wholesale with a fresh array rather than appended to, because appending to a
 * non-array would produce a file VS Code rejects. We're only ever adding our own
 * id, so any other extension ids already present are preserved.
 */
export function planProposedApi(
  existing: string | undefined,
  extensionId: string,
): ArgvPlan {
  // Tabs, because that's what VS Code ships argv.json with. jsonc-parser
  // reformats the region around its edit, so matching the file's native style
  // keeps the diff to exactly the key we added instead of gratuitously
  // reindenting the user's neighbouring lines.
  const formatting = {
    formattingOptions: { tabSize: 4, insertSpaces: false, eol: "\n" },
  };

  if (existing === undefined) {
    // Absent file: create one carrying only our key. VS Code fills in its own
    // defaults for everything else, so a minimal file is safe. The header
    // explains to a human why phantombot touched it.
    const body = applyEdits(
      "{}",
      modify("{}", [ENABLE_PROPOSED_API_KEY], [extensionId], formatting),
    );
    return { kind: "write", updated: NEW_FILE_HEADER + body + "\n" };
  }

  const errors: ParseError[] = [];
  const parsed = parse(existing, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as Record<string, unknown> | undefined;
  if (errors.length > 0) return { kind: "unparseable" };

  const current = parsed?.[ENABLE_PROPOSED_API_KEY];
  const ids = Array.isArray(current)
    ? current.filter((v): v is string => typeof v === "string")
    : [];
  if (ids.includes(extensionId)) return { kind: "current" };

  const updated = applyEdits(
    existing,
    modify(existing, [ENABLE_PROPOSED_API_KEY], [...ids, extensionId], formatting),
  );
  return { kind: "write", updated };
}

const NEW_FILE_HEADER =
  "// This configuration file allows you to pass permanent command line\n" +
  "// arguments to VS Code. Created by phantombot to enable the chat-session\n" +
  "// proposed APIs for its side-loaded extension.\n" +
  "//\n" +
  "// NOTE: Changing this file requires a restart of VS Code.\n";

export interface ProposedApiOptions {
  deps?: ArgvDeps;
  extensionId?: string;
  /**
   * The `code` CLI the extension was actually installed with, as resolved by
   * `resolveCodeCli()`. Selects the matching data folder so we allow-list the
   * extension in the same distribution we installed it into. Omit for stable.
   */
  codeCommand?: string;
}

/**
 * Report-only probe (doctor --no-repair): is our extension allow-listed?
 * NEVER writes, NEVER throws, NEVER creates the file.
 */
export function checkProposedApi(
  options: ProposedApiOptions = {},
): ProposedApiResult {
  const deps = options.deps ?? defaultArgvDeps(options.codeCommand);
  const extensionId = options.extensionId ?? VSCODE_EXTENSION_ID;
  try {
    const plan = planProposedApi(deps.read(deps.argvPath), extensionId);
    switch (plan.kind) {
      case "current":
        return { status: "current", argvPath: deps.argvPath };
      case "unparseable":
        return {
          status: "error",
          argvPath: deps.argvPath,
          error: `${deps.argvPath} is not parseable as JSONC — left untouched`,
        };
      case "write":
        return { status: "stale", argvPath: deps.argvPath };
    }
  } catch (e) {
    return {
      status: "error",
      argvPath: deps.argvPath,
      error: (e as Error).message,
    };
  }
}

/**
 * Idempotently allow-list our extension for its declared proposed APIs.
 * NEVER throws — a failure here must never break daemon startup.
 */
export function ensureProposedApi(
  options: ProposedApiOptions = {},
): ProposedApiResult {
  const deps = options.deps ?? defaultArgvDeps(options.codeCommand);
  const extensionId = options.extensionId ?? VSCODE_EXTENSION_ID;
  try {
    const existing = deps.read(deps.argvPath);
    const plan = planProposedApi(existing, extensionId);
    if (plan.kind === "current") {
      return { status: "current", argvPath: deps.argvPath };
    }
    if (plan.kind === "unparseable") {
      return {
        status: "error",
        argvPath: deps.argvPath,
        error:
          `${deps.argvPath} is not parseable as JSONC — refusing to touch it ` +
          `to avoid data loss. Add "${extensionId}" to its ` +
          `"${ENABLE_PROPOSED_API_KEY}" array by hand.`,
      };
    }

    let backupPath: string | undefined;
    if (existing !== undefined) {
      backupPath = `${deps.argvPath}.phantombot-bak`;
      deps.write(backupPath, existing);
    }
    deps.write(deps.argvPath, plan.updated);
    return { status: "enabled", argvPath: deps.argvPath, ...(backupPath ? { backupPath } : {}) };
  } catch (e) {
    return {
      status: "error",
      argvPath: deps.argvPath,
      error: (e as Error).message,
    };
  }
}

/** Production deps: real fs, real home, the resolved distribution's argv.json. */
export function defaultArgvDeps(codeCommand?: string): ArgvDeps {
  return {
    argvPath: defaultVscodeArgvPath(codeCommand),
    read: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw e;
      }
    },
    write: (p, contents) => {
      mkdirSync(dirname(p), { recursive: true });
      // Atomic: temp file + rename, so a crash mid-write can never leave VS
      // Code with a truncated argv.json (which it would refuse to start on).
      const tmp = `${p}.phantombot-tmp`;
      writeFileSync(tmp, contents, "utf8");
      renameSync(tmp, p);
    },
  };
}
