/**
 * `phantombot start` — start the installed phantombot background service via
 * the host's service manager (systemd / launchd / Task Scheduler).
 *
 * This is the daemon counterpart to `phantombot run` (which stays in the
 * foreground). Requires `phantombot install` to have registered the service
 * first. OS-agnostic: the actual verb is resolved by the platform router.
 */

import { defineCommand } from "citty";

import { runLifecycleAction } from "../lib/serviceLifecycle.ts";

export default defineCommand({
  meta: {
    name: "start",
    description:
      "Start the installed phantombot background service (systemd/launchd/Task Scheduler). Run 'phantombot install' first.",
  },
  async run() {
    process.exitCode = await runLifecycleAction({ action: "start" });
  },
});
