/**
 * `phantombot stop` — stop the phantombot background service and keep it
 * down via the host's service manager.
 *
 * On macOS (launchd KeepAlive) and Windows (1-minute TimeTrigger) the
 * supervisor would relaunch a merely-killed process, so `stop` disables that
 * keep-alive; `phantombot start` re-arms it. On Linux the main unit is
 * Restart=on-failure, so a clean stop just stays stopped. OS-agnostic: the
 * verb is resolved by the platform router.
 */

import { defineCommand } from "citty";

import { runLifecycleAction } from "../lib/serviceLifecycle.ts";

export default defineCommand({
  meta: {
    name: "stop",
    description:
      "Stop the phantombot background service and keep it down until 'phantombot start'.",
  },
  async run() {
    process.exitCode = await runLifecycleAction({ action: "stop" });
  },
});
