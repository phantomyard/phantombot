/**
 * Zero-touch installation of the shell tab-completion into the user's shells.
 *
 * `phantombot install` and `phantombot update` call `installCompletions()` so
 * completion "just works" after either, with no extra command to run and no
 * separate opt-in. `phantombot uninstall` calls `uninstallCompletions()` to
 * undo it cleanly.
 *
 * Strategy per shell — chosen so it works WITHOUT depending on the
 * bash-completion package being present or `$fpath` being pre-configured, and
 * without spawning a subprocess on every shell startup:
 *
 *   bash / zsh  The stub script (completionScript) is written under
 *               ~/.config/phantombot/completions/, and a small guarded block is
 *               appended to ~/.bashrc / ~/.zshrc that sources it. The block is
 *               delimited by BEGIN/END markers so it is idempotent (re-run
 *               replaces it) and removable on uninstall.
 *   fish        The stub is written straight to
 *               ~/.config/fish/completions/phantombot.fish, which fish
 *               auto-loads — no rc edit needed.
 *
 * On every <TAB> the stub still calls the dynamic `phantombot _complete`
 * backend, so the completion never drifts from the real command surface.
 *
 * POSIX only. On Windows this is a no-op (PowerShell completion is a separate
 * mechanism); callers get an empty result and print nothing.
 */

import { readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { xdgConfigHome } from "../config.ts";
import { completionScript, type CompletionShell } from "./completion.ts";
import { writeFileAtomic, type WriteSink } from "./io.ts";

const BLOCK_BEGIN = "# >>> phantombot completion >>>";
const BLOCK_END = "# <<< phantombot completion <<<";

export interface CompletionInstallOptions {
  /** Home directory. Defaults to os.homedir(). Tests override. */
  home?: string;
  /** XDG config home. Defaults to xdgConfigHome(). Tests override. */
  configHome?: string;
  /** The user's login shell path ($SHELL). Defaults to process.env.SHELL. */
  shell?: string;
  /** Host platform. Defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Message sink. Defaults to process.stdout. */
  out?: WriteSink;
}

/** Absolute paths this module reads and writes, resolved from the options. */
interface Paths {
  home: string;
  bashrc: string;
  zshrc: string;
  bashStub: string;
  zshStub: string;
  fishCompletion: string;
}

function resolvePaths(opts: CompletionInstallOptions): Paths {
  const home = opts.home ?? homedir();
  const configHome = opts.configHome ?? xdgConfigHome();
  const stubDir = join(configHome, "phantombot", "completions");
  return {
    home,
    bashrc: join(home, ".bashrc"),
    zshrc: join(process.env.ZDOTDIR || home, ".zshrc"),
    bashStub: join(stubDir, "phantombot.bash"),
    zshStub: join(stubDir, "phantombot.zsh"),
    fishCompletion: join(configHome, "fish", "completions", "phantombot.fish"),
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readOrEmpty(p: string): Promise<string> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return "";
  }
}

/**
 * Insert or replace the phantombot block in an rc file's text. Idempotent: a
 * second call with the same body is a no-op; a changed body replaces the old
 * block in place. Returns the new file text.
 */
export function upsertBlock(existing: string, body: string): string {
  const block = `${BLOCK_BEGIN}\n${body}\n${BLOCK_END}`;
  const begin = existing.indexOf(BLOCK_BEGIN);
  const end = existing.indexOf(BLOCK_END);
  if (begin !== -1 && end !== -1 && end > begin) {
    const before = existing.slice(0, begin);
    const after = existing.slice(end + BLOCK_END.length);
    return `${before}${block}${after}`;
  }
  const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  const lead = existing.length === 0 ? "" : "\n";
  return `${existing}${sep}${lead}${block}\n`;
}

/** Remove the phantombot block from an rc file's text. Returns the new text. */
export function removeBlock(existing: string): string {
  const begin = existing.indexOf(BLOCK_BEGIN);
  const end = existing.indexOf(BLOCK_END);
  if (begin === -1 || end === -1 || end < begin) return existing;
  let after = existing.slice(end + BLOCK_END.length);
  if (after.startsWith("\n")) after = after.slice(1);
  let before = existing.slice(0, begin);
  // Also drop the blank line we inserted before the block, if present.
  if (before.endsWith("\n\n")) before = before.slice(0, -1);
  return `${before}${after}`;
}

function bashSourceBody(stub: string): string {
  return `[ -f "${stub}" ] && . "${stub}"`;
}

function zshSourceBody(stub: string): string {
  // compinit must run before the stub's `compdef` call; do it defensively
  // (a second compinit is cheap and harmless) so completion works even when
  // the user's .zshrc never sets up the completion system itself.
  return (
    `if [ -f "${stub}" ]; then\n` +
    `  autoload -Uz compinit && compinit -u 2>/dev/null\n` +
    `  source "${stub}"\n` +
    `fi`
  );
}

/**
 * Decide which shells to set up: any shell whose rc/config already exists, plus
 * the user's current login shell (so a fresh box still gets its own shell wired
 * up even before that rc file exists).
 */
async function targetShells(
  paths: Paths,
  configHome: string,
  loginShell: string,
): Promise<Set<CompletionShell>> {
  const current = basename(loginShell || "");
  const shells = new Set<CompletionShell>();
  if ((await pathExists(paths.bashrc)) || current === "bash") shells.add("bash");
  if ((await pathExists(paths.zshrc)) || current === "zsh") shells.add("zsh");
  if ((await pathExists(join(configHome, "fish"))) || current === "fish")
    shells.add("fish");
  return shells;
}

/**
 * Install shell completion for the user's shells. Best-effort per shell: a
 * failure on one shell is reported but never throws. Returns the list of shells
 * successfully wired up.
 */
export async function installCompletions(
  opts: CompletionInstallOptions = {},
): Promise<{ installed: CompletionShell[] }> {
  const platform = opts.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin") return { installed: [] };

  const out = opts.out ?? process.stdout;
  const configHome = opts.configHome ?? xdgConfigHome();
  const paths = resolvePaths(opts);
  const shells = await targetShells(
    paths,
    configHome,
    opts.shell ?? process.env.SHELL ?? "",
  );

  const installed: CompletionShell[] = [];
  for (const shell of shells) {
    try {
      if (shell === "bash") {
        await writeFileAtomic(paths.bashStub, completionScript("bash"));
        const next = upsertBlock(
          await readOrEmpty(paths.bashrc),
          bashSourceBody(paths.bashStub),
        );
        await writeFileAtomic(paths.bashrc, next);
      } else if (shell === "zsh") {
        await writeFileAtomic(paths.zshStub, completionScript("zsh"));
        const next = upsertBlock(
          await readOrEmpty(paths.zshrc),
          zshSourceBody(paths.zshStub),
        );
        await writeFileAtomic(paths.zshrc, next);
      } else {
        await writeFileAtomic(paths.fishCompletion, completionScript("fish"));
      }
      installed.push(shell);
    } catch (e) {
      out.write(
        `warning: could not install ${shell} completion: ${(e as Error).message}\n`,
      );
    }
  }

  if (installed.length > 0) {
    out.write(
      `installed shell completion: ${installed.join(", ")} ` +
        `(open a new shell to activate)\n`,
    );
  }
  return { installed };
}

/**
 * Remove everything installCompletions() wrote: the stub files, the fish
 * completion, and the guarded blocks from the rc files. Best-effort; never
 * throws.
 */
export async function uninstallCompletions(
  opts: CompletionInstallOptions = {},
): Promise<void> {
  const platform = opts.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin") return;

  const paths = resolvePaths(opts);

  for (const stub of [paths.bashStub, paths.zshStub, paths.fishCompletion]) {
    await rm(stub, { force: true }).catch(() => {});
  }

  for (const rc of [paths.bashrc, paths.zshrc]) {
    try {
      const existing = await readFile(rc, "utf8");
      const next = removeBlock(existing);
      if (next !== existing) await writeFileAtomic(rc, next);
    } catch {
      // rc file absent or unreadable — nothing to clean.
    }
  }
}
