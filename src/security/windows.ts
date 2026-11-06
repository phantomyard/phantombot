/** Windows' built-in AppContainer + kill-on-close Job. No installer/admin. */
import { dlopen, ptr, type Pointer } from "bun:ffi";
import { createHash } from "node:crypto";
import {
  discardSandboxHome,
  neutralSandboxHome,
  sandboxEnvironment,
} from "./sandbox.ts";

const wide = (s: string) => Buffer.from(s + "\0", "utf16le");
const address = (b: Buffer, at = 0) => Number(b.readBigUInt64LE(at)) as Pointer;
export function windowsProfileName(workspace: string): string {
  return (
    "Phantombot." +
    createHash("sha256")
      .update(workspace.toLowerCase())
      .digest("hex")
      .slice(0, 32)
  );
}

/** Executed in a clean launcher subprocess; only stdio handles are inherited. */
export function windowsSandbox(workspace: string, command: string): number {
  const home = neutralSandboxHome();
  try {
    return windowsSandboxInHome(workspace, command, home);
  } finally {
    discardSandboxHome(home);
  }
}

function windowsSandboxInHome(
  workspace: string,
  command: string,
  home: string,
): number {
  if (process.arch !== "x64" && process.arch !== "arm64")
    throw new Error("unsupported Windows sandbox architecture");
  const user = dlopen("userenv.dll", {
    CreateAppContainerProfile: {
      args: ["ptr", "ptr", "ptr", "ptr", "u32", "ptr"],
      returns: "i32",
    },
    DeriveAppContainerSidFromAppContainerName: {
      args: ["ptr", "ptr"],
      returns: "i32",
    },
  });
  const adv = dlopen("advapi32.dll", {
    GetNamedSecurityInfoW: {
      args: ["ptr", "u32", "u32", "ptr", "ptr", "ptr", "ptr", "ptr"],
      returns: "u32",
    },
    SetNamedSecurityInfoW: {
      args: ["ptr", "u32", "u32", "ptr", "ptr", "ptr", "ptr"],
      returns: "u32",
    },
    SetEntriesInAclW: { args: ["u32", "ptr", "ptr", "ptr"], returns: "u32" },
    ConvertStringSecurityDescriptorToSecurityDescriptorW: {
      args: ["ptr", "u32", "ptr", "ptr"],
      returns: "bool",
    },
    SetFileSecurityW: { args: ["ptr", "u32", "ptr"], returns: "bool" },
    FreeSid: { args: ["ptr"], returns: "ptr" },
  });
  const kernel = dlopen("kernel32.dll", {
    GetLastError: { args: [], returns: "u32" },
    LocalFree: { args: ["ptr"], returns: "ptr" },
    InitializeProcThreadAttributeList: {
      args: ["ptr", "u32", "u32", "ptr"],
      returns: "bool",
    },
    UpdateProcThreadAttribute: {
      args: ["ptr", "u32", "u64", "ptr", "u64", "ptr", "ptr"],
      returns: "bool",
    },
    DeleteProcThreadAttributeList: { args: ["ptr"], returns: "void" },
    CreateProcessW: {
      args: [
        "ptr",
        "ptr",
        "ptr",
        "ptr",
        "bool",
        "u32",
        "ptr",
        "ptr",
        "ptr",
        "ptr",
      ],
      returns: "bool",
    },
    GetStdHandle: { args: ["i32"], returns: "ptr" },
    SetHandleInformation: { args: ["ptr", "u32", "u32"], returns: "bool" },
    CreateJobObjectW: { args: ["ptr", "ptr"], returns: "ptr" },
    SetInformationJobObject: {
      args: ["ptr", "u32", "ptr", "u32"],
      returns: "bool",
    },
    AssignProcessToJobObject: { args: ["ptr", "ptr"], returns: "bool" },
    ResumeThread: { args: ["ptr"], returns: "u32" },
    WaitForSingleObject: { args: ["ptr", "u32"], returns: "u32" },
    GetExitCodeProcess: { args: ["ptr", "ptr"], returns: "bool" },
    TerminateProcess: { args: ["ptr", "u32"], returns: "bool" },
    CloseHandle: { args: ["ptr"], returns: "bool" },
  });
  const check = (ok: unknown, operation: string) => {
    if (!ok)
      throw new Error(
        `sandbox unavailable: ${operation} (Win32 ${kernel.symbols.GetLastError()})`,
      );
  };
  const name = wide(windowsProfileName(workspace));
  const sidOut = Buffer.alloc(8);
  const created =
    user.symbols.CreateAppContainerProfile(
      name,
      name,
      name,
      null,
      0,
      sidOut,
    ) === 0;
  if (
    !created &&
    user.symbols.DeriveAppContainerSidFromAppContainerName(name, sidOut) !== 0
  )
    throw new Error("sandbox unavailable: AppContainer profile");
  const sid = address(sidOut);
  check(sid, "AppContainer SID");
  try {
    // The first launch's workspace is runtime-created and empty. Existing
    // profiles already have an inherited ACL: never re-walk agent-made links.
    if (created) {
      const oldAcl = Buffer.alloc(8),
        descriptor = Buffer.alloc(8),
        acl = Buffer.alloc(8);
      check(
        adv.symbols.GetNamedSecurityInfoW(
          wide(workspace),
          1,
          4,
          null,
          null,
          oldAcl,
          null,
          descriptor,
        ) === 0,
        "read workspace ACL",
      );
      const entry = Buffer.alloc(48);
      entry.writeUInt32LE(0x1301bf, 0);
      entry.writeUInt32LE(1, 4);
      entry.writeUInt32LE(3, 8);
      entry.writeUInt32LE(0, 28);
      entry.writeUInt32LE(5, 32);
      entry.writeBigUInt64LE(BigInt(sid), 40);
      try {
        check(
          adv.symbols.SetEntriesInAclW(1, entry, address(oldAcl), acl) === 0,
          "workspace ACL entry",
        );
        check(
          adv.symbols.SetNamedSecurityInfoW(
            wide(workspace),
            1,
            4,
            null,
            null,
            address(acl),
            null,
          ) === 0,
          "workspace ACL",
        );
      } finally {
        if (address(acl)) kernel.symbols.LocalFree(address(acl));
        if (address(descriptor)) kernel.symbols.LocalFree(address(descriptor));
      }
      const low = Buffer.alloc(8);
      check(
        adv.symbols.ConvertStringSecurityDescriptorToSecurityDescriptorW(
          wide("S:(ML;OICI;NW;;;LW)"),
          1,
          low,
          null,
        ),
        "low-integrity descriptor",
      );
      try {
        check(
          adv.symbols.SetFileSecurityW(wide(workspace), 0x10, address(low)),
          "workspace integrity",
        );
      } finally {
        kernel.symbols.LocalFree(address(low));
      }
    }
    const size = Buffer.alloc(8);
    kernel.symbols.InitializeProcThreadAttributeList(null, 2, 0, size);
    const attrs = Buffer.alloc(address(size));
    check(
      kernel.symbols.InitializeProcThreadAttributeList(attrs, 2, 0, size),
      "process attributes",
    );
    const capabilities = Buffer.alloc(24);
    capabilities.writeBigUInt64LE(BigInt(sid));
    const handles = Buffer.alloc(24),
      startup = Buffer.alloc(112),
      info = Buffer.alloc(24);
    startup.writeUInt32LE(112);
    startup.writeUInt32LE(0x100, 60);
    startup.writeBigUInt64LE(BigInt(ptr(attrs)), 104);
    for (let i = 0; i < 3; i++) {
      const handle = kernel.symbols.GetStdHandle(-10 - i);
      check(handle, "stdio handle");
      check(
        kernel.symbols.SetHandleInformation(handle, 1, 1),
        "stdio inheritance",
      );
      handles.writeBigUInt64LE(BigInt(Number(handle)), i * 8);
      startup.writeBigUInt64LE(BigInt(Number(handle)), 80 + i * 8);
    }
    const job = kernel.symbols.CreateJobObjectW(null, null);
    check(job, "job");
    try {
      const limits = Buffer.alloc(144);
      limits.writeUInt32LE(0x2000 | 0x200 | 0x8, 16);
      limits.writeUInt32LE(128, 40);
      limits.writeBigUInt64LE(2n * 1024n * 1024n * 1024n, 120);
      check(
        kernel.symbols.SetInformationJobObject(job, 9, limits, 144),
        "job limits",
      );
      check(
        kernel.symbols.UpdateProcThreadAttribute(
          attrs,
          0,
          0x20009,
          capabilities,
          24,
          null,
          null,
        ),
        "AppContainer attributes",
      );
      check(
        kernel.symbols.UpdateProcThreadAttribute(
          attrs,
          0,
          0x20002,
          handles,
          24,
          null,
          null,
        ),
        "stdio-only handle list",
      );
      const env = sandboxEnvironment(workspace, home);
      const environment = Buffer.from(
        Object.entries(env)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}=${v}\0`)
          .join("") + "\0",
        "utf16le",
      );
      const executable = `${env.SystemRoot}\\System32\\cmd.exe`;
      check(
        kernel.symbols.CreateProcessW(
          wide(executable),
          wide(`"${executable}" /d /s /c "${command}"`),
          null,
          null,
          true,
          0x80000 | 0x400 | 0x4,
          environment,
          wide(workspace),
          startup,
          info,
        ),
        "AppContainer process",
      );
      const processHandle = address(info),
        thread = address(info, 8);
      try {
        if (!kernel.symbols.AssignProcessToJobObject(job, processHandle)) {
          kernel.symbols.TerminateProcess(processHandle, 126);
          throw new Error("sandbox unavailable: job assignment");
        }
        check(
          kernel.symbols.ResumeThread(thread) !== 0xffffffff,
          "resume sandbox",
        );
        check(
          kernel.symbols.WaitForSingleObject(processHandle, 0xffffffff) === 0,
          "wait sandbox",
        );
        const exit = Buffer.alloc(4);
        check(
          kernel.symbols.GetExitCodeProcess(processHandle, exit),
          "exit code",
        );
        return exit.readUInt32LE();
      } finally {
        kernel.symbols.CloseHandle(thread);
        kernel.symbols.CloseHandle(processHandle);
      }
    } finally {
      kernel.symbols.CloseHandle(job);
      kernel.symbols.DeleteProcThreadAttributeList(attrs);
    }
  } finally {
    adv.symbols.FreeSid(sid);
  }
}

export function deleteWindowsProfile(workspace: string): void {
  if (process.platform !== "win32") return;
  const lib = dlopen("userenv.dll", {
    DeleteAppContainerProfile: { args: ["ptr"], returns: "i32" },
  });
  try {
    lib.symbols.DeleteAppContainerProfile(wide(windowsProfileName(workspace)));
  } finally {
    lib.close();
  }
}
