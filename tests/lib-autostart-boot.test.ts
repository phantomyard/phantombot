import { describe, expect, test } from "bun:test";
import {
  enableBootLinux,
  enableBootLinuxPasswordless,
  probeSudoPasswordless,
  validateSudoPassword,
  type SpawnRunner,
} from "../src/lib/autostartBoot.ts";

function runner(
  impl: (argv: string[], opts?: { input?: string }) => { exit: number; stdout?: string; stderr?: string },
): SpawnRunner {
  return {
    run: async (argv, opts) => {
      const r = impl(argv, opts);
      return { exit: r.exit, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
  };
}

describe("probeSudoPasswordless", () => {
  test("exit 0 → passwordless", async () => {
    let argv: string[] = [];
    const r = await probeSudoPasswordless(
      runner((a) => {
        argv = a;
        return { exit: 0 };
      }),
    );
    expect(argv).toEqual(["sudo", "-n", "true"]);
    expect(r).toBe(true);
  });

  test("exit 1 with 'a password is required' → password needed", async () => {
    const r = await probeSudoPasswordless(
      runner(() => ({ exit: 1, stderr: "sudo: a password is required" })),
    );
    expect(r).toBe(false);
  });

  test("sudo missing entirely → password path (never crash)", async () => {
    const r = await probeSudoPasswordless(
      runner(() => ({ exit: 127, stderr: "command not found: sudo" })),
    );
    expect(r).toBe(false);
  });
});

describe("enableBootLinuxPasswordless", () => {
  test("runs enable-linger with -n, as the user", async () => {
    let argv: string[] = [];
    const r = await enableBootLinuxPasswordless(
      "aghodges",
      runner((a) => {
        argv = a;
        return { exit: 0 };
      }),
    );
    expect(argv).toEqual(["sudo", "-n", "loginctl", "enable-linger", "aghodges"]);
    expect(r.status).toBe("ok");
  });

  test("linger failure (despite passwordless sudo) → failed, not invalid-credential", async () => {
    const r = await enableBootLinuxPasswordless(
      "u",
      runner(() => ({ exit: 1, stderr: "Could not enable linger" })),
    );
    expect(r).toEqual({ status: "failed", error: "Could not enable linger" });
  });
});

describe("validateSudoPassword / enableBootLinux", () => {
  test("wrong password → invalid-credential (re-prompt signal)", async () => {
    const v = await validateSudoPassword(
      "wrong",
      runner((_a, opts) => ({
        exit: 1,
        stderr: "sudo: 1 incorrect password attempt",
        ...(opts?.input ? {} : {}),
      })),
    );
    expect(v.status).toBe("invalid-credential");
  });

  test("right password → ok, then linger runs with -S -k and the password on stdin", async () => {
    const calls: string[][] = [];
    const r = await enableBootLinux(
      "secret",
      "aghodges",
      runner((a, opts) => {
        calls.push(a);
        if (a.includes("-v")) {
          // validator: succeeds only for the right password
          return (opts?.input ?? "").includes("secret")
            ? { exit: 0 }
            : { exit: 1, stderr: "sudo: 1 incorrect password attempt" };
        }
        return { exit: 0 };
      }),
    );
    expect(calls[1]).toEqual(["sudo", "-S", "-k", "loginctl", "enable-linger", "aghodges"]);
    expect(r.status).toBe("ok");
  });
});
