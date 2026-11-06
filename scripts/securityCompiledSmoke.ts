/** Runs the compiled launcher with no source checkout paths in its environment. */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { sandboxEnvironment, runSandbox } from "../src/security/sandbox.ts";
import { deleteWindowsProfile } from "../src/security/windows.ts";
const binary = resolve(process.argv[2]!);
const workspace = mkdtempSync(join(tmpdir(), "pb-compiled-sandbox-"));
const outside = mkdtempSync(join(tmpdir(), "pb-compiled-outside-"));
const secret = join(outside, "secret");
writeFileSync(secret, "compiled-host-secret");
try {
  if (process.platform === "darwin") {
    // Seatbelt is the native system launcher; the source/engine path is the
    // same enforcement primitive as the CLI on this platform.
    const result = await runSandbox(
      workspace,
      `echo compiled-ok; cat '${secret}'`,
    );
    if (
      !result.output.includes("compiled-ok") ||
      result.output.includes("compiled-host-secret")
    )
      throw new Error(JSON.stringify(result));
  } else if (process.platform === "win32") {
    const r = spawnSync(
      binary,
      ["__sandbox_exec", workspace, `echo compiled-ok & type "${secret}"`],
      { env: sandboxEnvironment(workspace), encoding: "utf8", timeout: 15000 },
    );
    if (
      !r.stdout?.includes("compiled-ok") ||
      r.stdout.includes("compiled-host-secret")
    )
      throw new Error(
        JSON.stringify({
          code: r.status,
          stdout: r.stdout,
          stderr: r.stderr,
          error: r.error?.message,
        }),
      );
  } else {
    // Reuse the runtime's supervisor, but launch THIS compiled binary rather
    // than loading source. See PHANTOMBOT_SANDBOX_TEST_BINARY below.
    const result = await runSandbox(
      workspace,
      `echo compiled-ok; cat '${secret}'`,
      { launcher: [binary] },
    );
    if (
      !result.output.includes("compiled-ok") ||
      result.output.includes("compiled-host-secret")
    )
      throw new Error(JSON.stringify(result));
  }
  console.log("compiled sandbox smoke passed");
} finally {
  deleteWindowsProfile(workspace);
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}
