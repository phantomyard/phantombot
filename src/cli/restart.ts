/**
 * `phantombot restart` — bounce the phantombot background service via the
 * host's service manager (systemd / launchd / Task Scheduler).
 *
 * This is the EXTERNAL restart (run from a separate terminal), distinct from
 * the in-process `/restart` slash-command that a running service issues on
 * itself (see selfRestart in platform.ts). OS-agnostic: the verb is resolved
 * by the platform router.
 */

import { defineCommand } from "citty";

import { runLifecycleAction } from "../lib/serviceLifecycle.ts";

export default defineCommand({
  meta: {
    name: "restart",
    description:
      "Restart the phantombot background service (systemd/launchd/Task Scheduler).",
  },
  async run() {
    process.exitCode = await runLifecycleAction({ action: "restart" });
  },
});
