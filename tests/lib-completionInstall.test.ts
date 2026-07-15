/**
 * Tests for the zero-touch shell-completion installer (completionInstall.ts).
 *
 * Everything is driven against a throwaway HOME + XDG config dir so the tests
 * never touch the developer's real ~/.bashrc / ~/.zshrc / fish config. The
 * `shell` and `platform` options are injected rather than read from the
 * environment.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  installCompletions,
  removeBlock,
  uninstallCompletions,
  upsertBlock,
} from "../src/lib/completionInstall.ts";

let home: string;
let configHome: string;
const sink = { write: () => true };
let savedZdotdir: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "phantombot-comp-home-"));
  configHome = await mkdtemp(join(tmpdir(), "phantombot-comp-cfg-"));
  savedZdotdir = process.env.ZDOTDIR;
  delete process.env.ZDOTDIR;
});

afterEach(async () => {
  if (savedZdotdir === undefined) delete process.env.ZDOTDIR;
  else process.env.ZDOTDIR = savedZdotdir;
  await rm(home, { recursive: true, force: true });
  await rm(configHome, { recursive: true, force: true });
});

const opts = (extra: Record<string, unknown>) => ({
  home,
  configHome,
  out: sink,
  platform: "linux" as const,
  ...extra,
});

describe("upsertBlock / removeBlock", () => {
  const body = 'source "/x/y.bash"';

  test("appends a delimited block to empty content", () => {
    const out = upsertBlock("", body);
    expect(out).toContain("# >>> phantombot completion >>>");
    expect(out).toContain(body);
    expect(out).toContain("# <<< phantombot completion <<<");
  });

  test("preserves existing content and separates with a blank line", () => {
    const out = upsertBlock("export FOO=1", body);
    expect(out.startsWith("export FOO=1\n\n# >>> phantombot")).toBe(true);
  });

  test("is idempotent — re-inserting the same body does not stack blocks", () => {
    const once = upsertBlock("export FOO=1", body);
    const twice = upsertBlock(once, body);
    expect(twice).toBe(once);
    expect(twice.match(/phantombot completion >>>/g)?.length).toBe(1);
  });

  test("replaces a changed body in place", () => {
    const first = upsertBlock("keep=me", 'source "/old"');
    const second = upsertBlock(first, 'source "/new"');
    expect(second).toContain("keep=me");
    expect(second).toContain('source "/new"');
    expect(second).not.toContain('source "/old"');
    expect(second.match(/phantombot completion >>>/g)?.length).toBe(1);
  });

  test("removeBlock strips the block and its leading blank line", () => {
    const withBlock = upsertBlock("export FOO=1", body);
    expect(removeBlock(withBlock)).toBe("export FOO=1\n");
  });

  test("removeBlock is a no-op when no block is present", () => {
    expect(removeBlock("export FOO=1\n")).toBe("export FOO=1\n");
  });
});

describe("installCompletions", () => {
  test("bash: writes a stub and sources it from .bashrc", async () => {
    await writeFile(join(home, ".bashrc"), "export EXISTING=1\n");

    const { installed } = await installCompletions(opts({ shell: "/bin/bash" }));
    expect(installed).toEqual(["bash"]);

    const stub = await readFile(
      join(configHome, "phantombot", "completions", "phantombot.bash"),
      "utf8",
    );
    expect(stub).toContain("complete -F _phantombot_complete phantombot");

    const rc = await readFile(join(home, ".bashrc"), "utf8");
    expect(rc).toContain("export EXISTING=1");
    expect(rc).toContain("# >>> phantombot completion >>>");
    expect(rc).toContain('/phantombot/completions/phantombot.bash"');
  });

  test("zsh: sources the stub and runs compinit before it", async () => {
    await writeFile(join(home, ".zshrc"), "# my zshrc\n");

    const { installed } = await installCompletions(opts({ shell: "/usr/bin/zsh" }));
    expect(installed).toEqual(["zsh"]);

    const rc = await readFile(join(home, ".zshrc"), "utf8");
    expect(rc).toContain("compinit");
    expect(rc).toContain('/phantombot/completions/phantombot.zsh"');
  });

  test("fish: drops an auto-loaded completion file, no rc edit", async () => {
    await mkdir(join(configHome, "fish"), { recursive: true });

    const { installed } = await installCompletions(opts({ shell: "/usr/bin/fish" }));
    expect(installed).toEqual(["fish"]);

    const fishFile = await readFile(
      join(configHome, "fish", "completions", "phantombot.fish"),
      "utf8",
    );
    expect(fishFile).toContain("complete -c phantombot -f");
  });

  test("targets a shell purely because its rc file already exists", async () => {
    // Current shell is bash, but a ~/.zshrc exists → both get wired up.
    await writeFile(join(home, ".bashrc"), "");
    await writeFile(join(home, ".zshrc"), "");

    const { installed } = await installCompletions(opts({ shell: "/bin/bash" }));
    expect(installed.sort()).toEqual(["bash", "zsh"]);
  });

  test("is idempotent across repeated installs", async () => {
    await writeFile(join(home, ".bashrc"), "export EXISTING=1\n");
    await installCompletions(opts({ shell: "/bin/bash" }));
    await installCompletions(opts({ shell: "/bin/bash" }));
    const rc = await readFile(join(home, ".bashrc"), "utf8");
    expect(rc.match(/phantombot completion >>>/g)?.length).toBe(1);
  });

  test("windows is a no-op", async () => {
    const { installed } = await installCompletions(
      opts({ shell: "pwsh", platform: "win32" as NodeJS.Platform }),
    );
    expect(installed).toEqual([]);
  });
});

describe("uninstallCompletions", () => {
  test("removes the stub, the fish file, and the rc block", async () => {
    await writeFile(join(home, ".bashrc"), "export EXISTING=1\n");
    await mkdir(join(configHome, "fish"), { recursive: true });
    await installCompletions(opts({ shell: "/bin/bash" }));

    await uninstallCompletions(opts({}));

    const rc = await readFile(join(home, ".bashrc"), "utf8");
    expect(rc).toBe("export EXISTING=1\n");
    expect(rc).not.toContain("phantombot completion");

    // Stub file is gone.
    await expect(
      readFile(join(configHome, "phantombot", "completions", "phantombot.bash"), "utf8"),
    ).rejects.toThrow();
  });
});
