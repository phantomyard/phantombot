/**
 * Shared implementation for the `phantombot start | stop | restart` CLI
 * commands. Each command is a thin wrapper over `runLifecycleAction`, which
 * drives the host's service-manager backend via the platform-router
 * `ServiceControl` (systemd on Linux, launchd on macOS, Task Scheduler on
 * Windows) and prints a consistent, copy-pasteable result.
 *
 * Kept OS-agnostic on purpose: the command layer never touches
 * systemctl/launchctl/schtasks directly — it asks `ServiceControl` for the
 * verb and lets `./platform.ts` pick the backend. See platform.ts for the
 * per-OS keep-alive nuances (why `stop` disables launchd KeepAlive / the
 * Windows TimeTrigger, while a clean systemd stop just stays down).
 *
 * Pure on its inputs: callers (and tests) can inject a fake ServiceControl
 * and capture the output sinks, so none of this needs a real supervisor.
 */

import {
  defaultServiceControl,
  restartCommand,
  startCommand,
  statusCommand,
  stopCommand,
  type ServiceControl,
} from "./platform.ts";
import type { WriteSink } from "./io.ts";

export type LifecycleAction = "start" | "stop" | "restart";

export interface LifecycleOptions {
  action: LifecycleAction;
  /** Inject a fake ServiceControl in tests; defaults to the host backend. */
  serviceControl?: ServiceControl;
  out?: WriteSink;
  err?: WriteSink;
}

/** Past-tense success line + the copy-pasteable manual hint per action. */
function actionText(action: LifecycleAction): {
  done: string;
  hint: () => Promise<string>;
} {
  switch (action) {
    case "start":
      return { done: "started", hint: startCommand };
    case "stop":
      return { done: "stopped", hint: stopCommand };
    case "restart":
      return { done: "restarted", hint: restartCommand };
  }
}

/**
 * Run a start/stop/restart against the host service manager. Returns the
 * process exit code: 0 on success, 1 on failure. Never throws — a backend
 * error is reported and turned into a non-zero exit with a manual-command
 * hint, so the CLI stays scriptable.
 */
export async function runLifecycleAction(
  opts: LifecycleOptions,
): Promise<number> {
  const svc = opts.serviceControl ?? defaultServiceControl();
  const out = opts.out ?? process.stdout;
  const err = opts.err ?? process.stderr;
  const { done, hint } = actionText(opts.action);

  const r = await svc[opts.action]();
  if (r.ok) {
    out.write(`phantombot ${done}.\n`);
    return 0;
  }
  err.write(
    `${opts.action} failed: ${r.stderr ?? "unknown"} — run '${await hint()}' manually.\n` +
      `(check status with: ${await statusCommand()})\n`,
  );
  return 1;
}
