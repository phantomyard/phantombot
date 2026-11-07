/** Runs the compiled launcher with no source checkout paths in its environment. */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  discardSandboxHome,
  neutralSandboxHome,
  sandboxEnvironment,
} from "../src/security/sandbox.ts";
import { deleteWindowsProfile } from "../src/security/windows.ts";
const binary = resolve(process.argv[2]!);
const workspace = mkdtempSync(join(tmpdir(), "pb-compiled-sandbox-"));
const outside = mkdtempSync(join(tmpdir(), "pb-compiled-outside-"));
const secret = join(outside, "secret");
writeFileSync(secret, "compiled-host-secret");
const home = neutralSandboxHome();
try {
  const command =
    process.platform === "win32"
      ? `echo compiled-ok & type "${secret}"`
      : `echo compiled-ok; cat '${secret}'`;
  const run = spawnSync(binary, ["__sandbox_run", workspace, command], {
    // Exercise the AppContainer even where NUL is closed (Server 2022 CI).
    env: { ...sandboxEnvironment(workspace, home), PHANTOMBOT_WINDOWS_APPCONTAINER: "force" },
    encoding: "utf8",
    timeout: 15000,
  });
  if (run.status !== 0)
    throw new Error(
      JSON.stringify({
        code: run.status,
        stdout: run.stdout,
        stderr: run.stderr,
        error: run.error?.message,
      }),
    );
  const result = JSON.parse(run.stdout) as { output: string };
  if (
    !result.output.includes("compiled-ok") ||
    result.output.includes("compiled-host-secret")
  )
    throw new Error(JSON.stringify(result));
  console.log("compiled sandbox smoke passed");
} finally {
  discardSandboxHome(home);
  deleteWindowsProfile(workspace);
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}
