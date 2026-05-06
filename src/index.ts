#!/usr/bin/env bun
/**
 * Phantombot CLI entry point.
 *
 * Imports the Citty dispatcher and runs it. The dispatcher itself lives in
 * src/cli/index.ts so it can be imported by tests without auto-running.
 *
 * Before dispatch, we self-load credentials from `~/.env` and
 * `~/.config/phantombot/.env` into process.env. On Linux the systemd unit
 * already sources these via `EnvironmentFile=`, so the lines we'd add are
 * no-ops (existing values win — see preloadEnvFiles). On macOS launchd
 * has no equivalent of EnvironmentFile, so this self-load is the only
 * way credentials reach the running agent.
 */

import { runMain } from "citty";
import { mainCommand } from "./cli/index.ts";
import { preloadEnvFiles } from "./lib/envBootstrap.ts";

await preloadEnvFiles();
runMain(mainCommand);
