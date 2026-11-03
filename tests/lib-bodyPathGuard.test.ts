/**
 * Body-path guard (#718): a `gh` call that would publish a literal `@/path`
 * as a review/comment body is refused before it runs; the forms that DO read
 * the file (`--body-file`, `gh api -F body=@…`) and `@mention` bodies pass.
 */
import { describe, expect, test } from "bun:test";

import {
  bodyPathGuardCheck,
  claudeBodyGuardHookEntry,
  findLiteralBodyPath,
  phantombotBodyGuardExtension,
  runBodyGuardHook,
} from "../src/lib/bodyPathGuard.ts";

describe("findLiteralBodyPath", () => {
  // The four real incidents, verbatim in shape.
  const BLOCKED = [
    "gh pr review 715 --request-changes --body @/home/lena/scratch/review-body.md",
    "gh api -f body=@/tmp/kai-715-repost-ack.md repos/phantomyard/phantombot/issues/715/comments",
    "gh api repos/o/r/issues/717/comments -f body=@/tmp/lena717reply.md",
    'gh pr comment 301 --body "@/tmp/c301.md"',
    "gh pr comment 1 --body=@./notes.md",
    "gh issue comment 9 -b @~/r.md",
    "gh api --raw-field body=@/tmp/x.md repos/o/r/pulls/1/reviews",
    "cd /tmp && gh pr review 1 --approve --body @/tmp/r.md",
    // Review of #754: joined shorthand and bare relative paths.
    "gh pr comment 419 -b@/tmp/x.md",
    "gh pr comment 419 -b=@/tmp/x.md",
    "gh pr review 419 --body @review.md",
    'gh pr review 419 --body "@review.md"',
    "gh pr comment 1 --body @scratch/r754.md && echo ok",
    "gh api repos/o/r/issues/1/comments -f body=@reply.md",
  ];
  for (const cmd of BLOCKED) {
    test(`blocks: ${cmd}`, () => {
      expect(findLiteralBodyPath(cmd)).toBeDefined();
    });
  }

  const ALLOWED = [
    "gh pr review 715 --request-changes --body-file /tmp/review.md",
    "gh api -F body=@/tmp/review.md repos/o/r/issues/1/comments",
    'gh pr comment 1 --body "@kaieriksen thanks, fixed in abc123"',
    "gh api -f body=@lena repos/o/r/issues/1/comments",
    'gh pr comment 1 --body "@andrew please look"',
    'gh pr comment 1 --body "@kai.eriksen thanks"',
    "gh pr comment 1 -b@kaieriksen",
    "gh pr comment 1 --body-file -",
    "curl -d @/tmp/payload.json https://example.com --body @/tmp/x",
    "echo --body @/tmp/x",
  ];
  for (const cmd of ALLOWED) {
    test(`allows: ${cmd}`, () => {
      expect(findLiteralBodyPath(cmd)).toBeUndefined();
    });
  }
});

describe("bodyPathGuardCheck", () => {
  test("only shell tools are checked", () => {
    expect(bodyPathGuardCheck("Write", { command: "gh pr comment 1 --body @/tmp/x" })).toBeUndefined();
    expect(bodyPathGuardCheck("bash", { command: "gh pr comment 1 --body @/tmp/x" })).toContain("--body-file");
    expect(bodyPathGuardCheck("Bash", { command: "gh pr comment 1 --body @/tmp/x" })).toContain("--body-file");
  });
});

describe("runBodyGuardHook (claude PreToolUse)", () => {
  test("blocks with exit 2 and tells the model the right flag", () => {
    let err = "";
    const code = runBodyGuardHook(
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "gh pr review 1 --body @/tmp/r.md" } }),
      { stderr: (s) => { err += s; } },
    );
    expect(code).toBe(2);
    expect(err).toContain("--body-file");
  });

  test("allows an ordinary command and an unreadable event", () => {
    const io = { stderr: () => {} };
    expect(runBodyGuardHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }), io)).toBe(0);
    expect(runBodyGuardHook("not json", io)).toBe(0);
  });

  test("the hook entry matches Bash and re-enters phantombot", () => {
    const e = claudeBodyGuardHookEntry(["/bin/pb"]) as { matcher: string; hooks: Array<{ command: string }> };
    expect(e.matcher).toBe("Bash");
    expect(e.hooks[0]!.command).toBe('"/bin/pb" "__body_guard"');
  });
});

describe("phantombotBodyGuardExtension (native)", () => {
  test("registers unconditionally and blocks a literal-path body", async () => {
    let handler: ((e: { toolName: string; input: unknown }) => unknown) | undefined;
    phantombotBodyGuardExtension({ on: (_e, h) => { handler = h; } });
    expect(handler).toBeDefined();
    const blocked = (await handler!({ toolName: "bash", input: { command: "gh api -f body=@/tmp/x.md repos/o/r/issues/1/comments" } })) as { block: boolean };
    expect(blocked.block).toBe(true);
    expect(await handler!({ toolName: "bash", input: { command: "gh api -F body=@/tmp/x.md repos/o/r/issues/1/comments" } })).toBeUndefined();
  });
});
