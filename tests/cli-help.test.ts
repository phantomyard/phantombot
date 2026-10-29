/**
 * Contract for the root `phantombot --help` surface (src/cli/help.ts).
 *
 * Help is documentation that ships in the binary, so it gets the same treatment
 * as the README: bounded, grouped, and checked against the live dispatcher
 * rather than a copy of it. These tests fail when a command is added without a
 * group, when a description grows past one short line, or when the rendered
 * help overflows the terminal it is printed to.
 */

import { describe, expect, test } from "bun:test";

import { mainCommand } from "../src/cli/index.ts";
import { HELP_GROUPS, renderRootHelp } from "../src/cli/help.ts";
import { resolve } from "../src/lib/completion.ts";

/** The rule the surface has to keep: one short line per command. */
const DESCRIPTION_WORD_LIMIT = 20;

const subcommandKeys = Object.keys(mainCommand.subCommands ?? {});

const described = new Map<string, string>();
for (const [key, entry] of Object.entries(mainCommand.subCommands ?? {})) {
  const command = await resolve(entry);
  const meta = (await resolve(command?.meta)) ?? {};
  described.set(key, (meta.description ?? "").trim());
}

const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

describe("root help grouping", () => {
  test("every top-level command is listed exactly once", () => {
    const listed = HELP_GROUPS.flatMap((group) => group.commands);
    expect([...listed].sort()).toEqual([...subcommandKeys].sort());
    expect(new Set(listed).size, "a command is listed in two groups").toBe(listed.length);
  });

  test("no group is empty and titles are unique", () => {
    const titles = HELP_GROUPS.map((group) => group.title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const group of HELP_GROUPS) {
      expect(group.commands.length, `${group.title} is empty`).toBeGreaterThan(0);
    }
  });
});

describe("command descriptions", () => {
  test(`every description is at most ${DESCRIPTION_WORD_LIMIT} words`, () => {
    for (const [key, description] of described) {
      expect(description, `${key} has no description`).not.toBe("");
      expect(
        countWords(description),
        `${key}: ${description}`,
      ).toBeLessThanOrEqual(DESCRIPTION_WORD_LIMIT);
    }
  });

  test("no description is an unterminated sentence", () => {
    for (const [key, description] of described) {
      expect(description.endsWith("."), `${key} is missing its full stop`).toBe(true);
    }
  });
});

describe("rendered help", () => {
  const render = (columns: number) => renderRootHelp(mainCommand, { columns });

  test("stays inside the terminal width and lists every command", async () => {
    for (const columns of [60, 80, 100, 160]) {
      const output = await render(columns);
      const width = Math.min(columns, 100);
      for (const line of output.split("\n")) {
        expect(line.length, `${columns} cols: ${line}`).toBeLessThanOrEqual(width);
      }
      for (const key of subcommandKeys) {
        expect(output, `${columns} cols: ${key} missing`).toContain(`\n  ${key}`);
      }
      for (const group of HELP_GROUPS) expect(output).toContain(group.title);
    }
  });

  test("does not repeat every command in the USAGE line", async () => {
    // The pipe-separated command list was the worst offender: it duplicated the
    // whole surface above the list that actually describes it.
    const output = await render(80);
    const usage = output.split("\nUSAGE\n")[1]?.split("\n\n")[0] ?? "";
    expect(usage).not.toContain("|");
    expect(usage).toContain("phantombot <command> --help");
  });

  test("shows the version and the tagline", async () => {
    const output = await render(100);
    const meta = (await resolve(mainCommand.meta)) ?? {};
    expect(output.split("\n")[0]).toBe(`phantombot v${meta.version}`);
    expect(output).toContain("Giving the harness a Soul");
  });

  test("names OpenCode as a supported client", async () => {
    // The claim has to be backed by the surface, not just advertised.
    const output = await render(100);
    expect(output).toContain("OpenCode");
    expect(described.get("acp")).toContain("OpenCode");
  });
});
