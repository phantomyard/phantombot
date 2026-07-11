/**
 * Shell tab-completion engine for the phantombot CLI.
 *
 * Completion is dynamic: the per-shell stub scripts (see completionScript) are
 * tiny and, on every <TAB>, call back into a hidden `phantombot _complete --
 * <words…>` command. That command walks the live Citty command tree
 * (mainCommand) via computeCompletions and prints one candidate per line, so
 * the completion always matches the actual subcommands and flags.
 *
 * `_complete` is intercepted in src/index.ts before the credential bootstrap so
 * a tab press never touches the vault or provisions a persona, and it is not
 * registered as a Citty subcommand, so it stays out of `--help` output.
 */

import type { ArgsDef, CommandDef, Resolvable, SubCommandsDef } from "citty";

/**
 * Unwrap a Citty `Resolvable<T>` (a plain value, a Promise, or a
 * zero-arg (async) function) into its concrete value.
 */
export async function resolve<T>(x: Resolvable<T> | undefined): Promise<T | undefined> {
  if (typeof x === "function") return await (x as () => T | Promise<T>)();
  return await (x as T | Promise<T> | undefined);
}

/**
 * Compute completion candidates for a partially-typed command line.
 *
 * @param root    the top-level command tree (mainCommand).
 * @param tokens  every whitespace-separated word AFTER the program name, up to
 *                and including the word under the cursor. The LAST element is
 *                the partial word being completed and may be the empty string
 *                (e.g. when the cursor sits after a trailing space).
 * @returns       candidate completions, prefix-filtered against the partial
 *                word and de-duplicated, in a stable order.
 */
export async function computeCompletions(
  root: CommandDef,
  tokens: string[],
): Promise<string[]> {
  const current = tokens[tokens.length - 1] ?? "";
  const completed = tokens.slice(0, Math.max(0, tokens.length - 1));

  // Descend into subcommands following only the leading, non-flag words. The
  // first word that is neither a flag nor a known subcommand is a positional
  // argument of the current node, so descent stops there.
  let node: CommandDef = root;
  for (const word of completed) {
    if (word.startsWith("-")) continue; // flags never select a subcommand
    const subs = (await resolve(node.subCommands)) as SubCommandsDef | undefined;
    if (subs && Object.prototype.hasOwnProperty.call(subs, word)) {
      node = ((await resolve(subs[word])) as CommandDef) ?? node;
    } else {
      break;
    }
  }

  const subs = (await resolve(node.subCommands)) as SubCommandsDef | undefined;
  const argsDef = (await resolve(node.args)) as ArgsDef | undefined;

  const flagCandidates: string[] = [];
  if (argsDef) {
    for (const [name, def] of Object.entries(argsDef)) {
      if (def.type === "positional") continue;
      flagCandidates.push(`--${name}`);
      if (def.type === "boolean") flagCandidates.push(`--no-${name}`);
      // `alias` is absent from PositionalArgDef, so read it off a widened view.
      const alias = (def as { alias?: string | string[] }).alias;
      const aliases = Array.isArray(alias) ? alias : alias ? [alias] : [];
      for (const a of aliases) flagCandidates.push(a.length === 1 ? `-${a}` : `--${a}`);
    }
  }
  // Citty injects --help everywhere; --version only exists on the root command.
  flagCandidates.push("--help");
  if (node === root) flagCandidates.push("--version");

  const subCandidates = subs ? Object.keys(subs) : [];

  // When the user is typing a flag, only offer flags. Otherwise offer
  // subcommands if this node has any, else fall back to its flags so a leaf
  // command still completes something useful on an empty <TAB>.
  const pool = current.startsWith("-")
    ? flagCandidates
    : subCandidates.length
      ? subCandidates
      : flagCandidates;

  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of pool) {
    if (c.startsWith(current) && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

/**
 * Extract the completion word list from a raw `_complete` argv and compute the
 * candidates. The shell stubs always invoke `phantombot _complete -- <words…>`,
 * so everything after the first `--` is the verbatim word list (using `--`
 * keeps half-typed flags like `--foo` out of Citty's own arg parser).
 */
export async function runComplete(root: CommandDef, argv: string[]): Promise<string[]> {
  const dashIndex = argv.indexOf("--");
  const tokens = dashIndex >= 0 ? argv.slice(dashIndex + 1) : argv;
  return computeCompletions(root, tokens);
}

export type CompletionShell = "bash" | "zsh" | "fish";

export const COMPLETION_SHELLS: readonly CompletionShell[] = ["bash", "zsh", "fish"];

export function isCompletionShell(value: string): value is CompletionShell {
  return (COMPLETION_SHELLS as readonly string[]).includes(value);
}

/**
 * Return the shell script that wires <TAB> to the dynamic `_complete` backend.
 * `install` writes this to the user's shell (see completionInstall).
 */
export function completionScript(shell: CompletionShell, program = "phantombot"): string {
  switch (shell) {
    case "bash":
      return bashScript(program);
    case "zsh":
      return zshScript(program);
    case "fish":
      return fishScript(program);
  }
}

function bashScript(program: string): string {
  return `# ${program} bash completion (installed by \`${program} install\`)
_${program}_complete() {
  local cword="\${COMP_CWORD}"
  local cur="\${COMP_WORDS[cword]}"
  local tokens=("\${COMP_WORDS[@]:1:cword}")
  local reply
  reply="$(${program} _complete -- "\${tokens[@]}" 2>/dev/null)"
  local IFS=$'\\n'
  COMPREPLY=($(compgen -W "\${reply}" -- "\${cur}"))
}
complete -F _${program}_complete ${program}
`;
}

function zshScript(program: string): string {
  return `#compdef ${program}
# ${program} zsh completion (installed by \`${program} install\`)
_${program}() {
  local -a reply
  local -a tokens
  tokens=("\${(@)words[2,$CURRENT]}")
  local raw
  raw="$(${program} _complete -- "\${tokens[@]}" 2>/dev/null)"
  [[ -n "$raw" ]] && reply=("\${(@f)raw}")
  compadd -- "\${reply[@]}"
}
compdef _${program} ${program}
`;
}

function fishScript(program: string): string {
  return `# ${program} fish completion (installed by \`${program} install\`)
function __${program}_complete
    set -l tokens (commandline -opc)
    set -e tokens[1]
    set -l current (commandline -ct)
    ${program} _complete -- $tokens "$current" 2>/dev/null
end
complete -c ${program} -f -a '(__${program}_complete)'
`;
}
