#!/usr/bin/env bun
/**
 * Phantombot CLI entry point.
 *
 * Imports the Citty dispatcher and runs it. The dispatcher itself lives in
 * src/cli/index.ts so it can be imported by tests without auto-running.
 */

import { runMain } from "citty";
import { mainCommand } from "./cli/index.ts";

runMain(mainCommand);
