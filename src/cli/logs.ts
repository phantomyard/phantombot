/**
 * `phantombot logs` — tail the phantombot service logs, resolved for the host
 * platform (journalctl on Linux, the launchd out/err log files on macOS, the
 * Task Scheduler out log on Windows).
 *
 * Follows by default (like `tail -f`); pass `--no-follow` to print the last N
 * lines and exit. OS-agnostic: the concrete command is built by `logsSpec`.
 */

import { defineCommand } from "citty";

import { logsCommand, logsSpec } from "../lib/platform.ts";

export default defineCommand({
  meta: {
    name: "logs",
    description:
      "Tail the phantombot service logs (journalctl/launchd/Task Scheduler). Follows by default; --no-follow prints the last N and exits.",
  },
  args: {
    follow: {
      type: "boolean",
      description: "Stream new lines as they arrive. Use --no-follow to print and exit.",
      default: true,
    },
    lines: {
      type: "string",
      description: "How many trailing lines to show before following.",
      default: "50",
    },
  },
  async run({ args }) {
    const parsed = Number.parseInt(String(args.lines), 10);
    const lines = Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
    const spec = logsSpec({ follow: args.follow as boolean, lines });

    if (!spec) {
      process.stderr.write(
        `phantombot has no log backend on ${process.platform}.\n` +
          `view logs manually with: ${logsCommand()}\n`,
      );
      process.exitCode = 1;
      return;
    }

    try {
      const proc = Bun.spawn([spec.cmd, ...spec.args], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      process.exitCode = await proc.exited;
    } catch (e) {
      // The tailer binary isn't on PATH (e.g. journalctl absent in a
      // container). Fall back to the copy-pasteable hint rather than crash.
      process.stderr.write(
        `could not run '${spec.cmd}': ${(e as Error).message}\n` +
          `view logs manually with: ${logsCommand()}\n`,
      );
      process.exitCode = 1;
    }
  },
});
