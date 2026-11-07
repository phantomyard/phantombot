/** Windows' built-in AppContainer + kill-on-close Job. No installer/admin. */
import { dlopen, ptr, read, type Pointer } from "bun:ffi";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { TRAVERSE_CAPABILITY, TRAVERSE_MASK } from "./windowsScratch.ts";
import {
  discardSandboxHome,
  neutralSandboxHome,
  sandboxContextFromEnv,
  sandboxEnvironment,
} from "./sandbox.ts";

const wide = (s: string) => Buffer.from(s + "\0", "utf16le");
const address = (b: Buffer, at = 0) => Number(b.readBigUInt64LE(at)) as Pointer;
const readWide = (p: Pointer, max = 1024): string => {
  let out = "";
  for (let at = 0; at < max; at += 2) {
    const unit = read.u16(p, at);
    if (unit === 0) break;
    out += String.fromCharCode(unit);
  }
  return out;
};
export { TRAVERSE_CAPABILITY };

/** Free drive letters, Z: first; A:-C: are never used. */
export function freeDriveLetters(logicalDrives: number): string[] {
  const out: string[] = [];
  for (let i = 25; i >= 3; i--)
    if (!(logicalDrives & (1 << i))) out.push(`${String.fromCharCode(65 + i)}:`);
  return out;
}

/** A drive-letter target left behind by a killed launcher (workspace gone). */
export function isStaleSandboxDrive(
  targets: string[],
  exists: (path: string) => boolean,
): boolean {
  if (targets.length !== 1 || !targets[0]!.startsWith("\\??\\")) return false;
  const path = targets[0]!.slice(4);
  return (
    /\\(?:phantom-sandbox|scratch\\untrusted|sandbox\\run-)/i.test(path) &&
    !exists(path)
  );
}

/** Every parent of `folder`, drive root first, excluding `folder` itself. */
export function windowsParents(folder: string): string[] {
  const parts = folder.replace(/[\\/]+$/, "").split(/[\\/]+/);
  if (parts.length < 2 || !/^[A-Za-z]:$/.test(parts[0]!)) return [];
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++)
    out.push(i === 1 ? `${parts[0]}\\` : parts.slice(0, i).join("\\"));
  return out;
}

/**
 * The DACL SDDL with one explicit, non-inheritable traverse ACE for
 * `capability`, placed after the explicit ACEs (canonical order). Unchanged
 * when the ACE is already there or the DACL is absent/NULL.
 */
export function withTraverseAce(sddl: string, capability: string): string {
  const ace = `(A;;${TRAVERSE_MASK};;;${capability})`;
  const match = /^D:([A-Z]*)((?:\([^)]*\))*)$/.exec(sddl);
  if (!match || sddl.toUpperCase().includes(ace.toUpperCase())) return sddl;
  const aces = match[2]!.match(/\([^)]*\)/g) ?? [];
  if (!aces.length) return sddl;
  const inherited = aces.findIndex((a) => /^\([^;]*;[^;]*ID/.test(a));
  const at = inherited < 0 ? aces.length : inherited;
  aces.splice(at, 0, ace);
  return `D:${match[1]}${aces.join("")}`;
}

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
  given: string,
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
    ConvertStringSidToSidW: { args: ["ptr", "ptr"], returns: "bool" },
    ConvertSidToStringSidW: { args: ["ptr", "ptr"], returns: "bool" },
    ConvertSecurityDescriptorToStringSecurityDescriptorW: {
      args: ["ptr", "u32", "u32", "ptr", "ptr"],
      returns: "bool",
    },
    GetFileSecurityW: {
      args: ["ptr", "u32", "ptr", "u32", "ptr"],
      returns: "bool",
    },
    OpenProcessToken: { args: ["ptr", "u32", "ptr"], returns: "bool" },
    GetTokenInformation: {
      args: ["ptr", "u32", "ptr", "u32", "ptr"],
      returns: "bool",
    },
  });
  const ui = dlopen("user32.dll", {
    GetProcessWindowStation: { args: [], returns: "ptr" },
    SetProcessWindowStation: { args: ["ptr"], returns: "bool" },
    CreateWindowStationW: {
      args: ["ptr", "u32", "u32", "ptr"],
      returns: "ptr",
    },
    CreateDesktopW: {
      args: ["ptr", "ptr", "ptr", "u32", "u32", "ptr"],
      returns: "ptr",
    },
    CloseDesktop: { args: ["ptr"], returns: "bool" },
    CloseWindowStation: { args: ["ptr"], returns: "bool" },
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
    GetCurrentProcess: { args: [], returns: "ptr" },
    GetLongPathNameW: { args: ["ptr", "ptr", "u32"], returns: "u32" },
    DefineDosDeviceW: { args: ["u32", "ptr", "ptr"], returns: "bool" },
    QueryDosDeviceW: { args: ["ptr", "ptr", "u32"], returns: "u32" },
    GetLogicalDrives: { args: [], returns: "u32" },
    CreateMutexW: { args: ["ptr", "bool", "ptr"], returns: "ptr" },
    ReleaseMutex: { args: ["ptr"], returns: "bool" },
  });
  // PowerShell expands 8.3 names (C:\Users\RUNNER~1) by listing each
  // parent, which the AppContainer may not do. Work on the long path; the
  // profile stays keyed on the path we were given (deleteWindowsProfile).
  const workspace = (() => {
    const out = Buffer.alloc(32768 * 2);
    const n = kernel.symbols.GetLongPathNameW(wide(given), out, 32768);
    return n > 0 && n < 32768 ? out.toString("utf16le", 0, n * 2) : given;
  })();
  const base = dlopen("kernelbase.dll", {
    DeriveCapabilitySidsFromName: {
      args: ["ptr", "ptr", "ptr", "ptr", "ptr"],
      returns: "bool",
    },
  });
  const check = (ok: unknown, operation: string) => {
    if (!ok)
      throw new Error(
        `sandbox unavailable: ${operation} (Win32 ${kernel.symbols.GetLastError()})`,
      );
  };
  const sidString = (value: Pointer | number, what: string): string => {
    const out = Buffer.alloc(8);
    check(adv.symbols.ConvertSidToStringSidW(value as Pointer, out), what);
    try {
      return readWide(address(out));
    } finally {
      kernel.symbols.LocalFree(address(out));
    }
  };
  const userSid = (): string => {
    const token = Buffer.alloc(8);
    check(
      adv.symbols.OpenProcessToken(
        kernel.symbols.GetCurrentProcess(),
        0x8, // TOKEN_QUERY
        token,
      ),
      "process token",
    );
    try {
      const info = Buffer.alloc(256),
        used = Buffer.alloc(4);
      check(
        adv.symbols.GetTokenInformation(address(token), 1, info, 256, used),
        "token user",
      ); // TokenUser: TOKEN_USER { SID_AND_ATTRIBUTES { PSID, u32 } }
      return sidString(address(info), "user SID");
    } finally {
      kernel.symbols.CloseHandle(address(token));
    }
  };
  const privateDesktop = (container: Pointer) => {
    // Only this user, SYSTEM and this run's AppContainer; low-integrity
    // label so the low-IL sandbox may write to it.
    const sddl =
      `D:P(A;;GA;;;${userSid()})(A;;GA;;;${sidString(container, "AppContainer SID")})(A;;GA;;;SY)` +
      "S:(ML;;NW;;;LW)";
    const descriptor = Buffer.alloc(8);
    check(
      adv.symbols.ConvertStringSecurityDescriptorToSecurityDescriptorW(
        wide(sddl),
        1,
        descriptor,
        null,
      ),
      "desktop descriptor",
    );
    const attributes = Buffer.alloc(24);
    attributes.writeUInt32LE(24, 0);
    attributes.writeBigUInt64LE(BigInt(address(descriptor)), 8);
    const station = `Phantombot-${randomBytes(8).toString("hex")}`;
    let winsta: Pointer | null = null,
      desktop: Pointer | null = null;
    const previous = ui.symbols.GetProcessWindowStation();
    try {
      winsta = ui.symbols.CreateWindowStationW(
        wide(station),
        0,
        0x37f, // WINSTA_ALL_ACCESS
        attributes,
      );
      check(winsta, "window station");
      check(ui.symbols.SetProcessWindowStation(winsta), "enter window station");
      try {
        desktop = ui.symbols.CreateDesktopW(
          wide("Default"),
          null,
          null,
          0,
          0x10000000, // GENERIC_ALL
          attributes,
        );
      } finally {
        if (previous) ui.symbols.SetProcessWindowStation(previous);
      }
      check(desktop, "desktop");
    } catch (error) {
      if (desktop) ui.symbols.CloseDesktop(desktop);
      if (winsta) ui.symbols.CloseWindowStation(winsta);
      throw error;
    } finally {
      kernel.symbols.LocalFree(address(descriptor));
    }
    return {
      name: wide(`${station}\\Default`),
      close() {
        ui.symbols.CloseDesktop(desktop!);
        ui.symbols.CloseWindowStation(winsta!);
      },
    };
  };
  let traverseFree: (() => void) | undefined;
  const traverseCapability = () => {
    const groups = Buffer.alloc(8),
      groupCount = Buffer.alloc(4),
      sids = Buffer.alloc(8),
      sidCount = Buffer.alloc(4);
    check(
      base.symbols.DeriveCapabilitySidsFromName(
        wide(TRAVERSE_CAPABILITY),
        groups,
        groupCount,
        sids,
        sidCount,
      ),
      "traverse capability",
    );
    const free = (list: Buffer, count: Buffer) => {
      const array = address(list);
      if (!array) return;
      for (let i = 0; i < count.readUInt32LE(); i++)
        kernel.symbols.LocalFree(read.ptr(array, i * 8) as Pointer);
      kernel.symbols.LocalFree(array);
    };
    free(groups, groupCount);
    check(sidCount.readUInt32LE() >= 1, "traverse capability SID");
    const capability = read.ptr(address(sids), 0) as Pointer;
    traverseFree = () => free(sids, sidCount);
    return { sid: capability, text: sidString(capability, "capability SID") };
  };
  const grantParents = (folder: string, capability: string) => {
    for (const parent of windowsParents(folder)) {
      // Only our own tree (windowsScratch.ts): never the user's profile.
      if (!/\\phantom-sandbox(?:\\|$)/i.test(parent)) continue;
      const sddl = readDacl(parent);
      if (sddl === undefined) continue;
      const next = withTraverseAce(sddl, capability);
      if (next === sddl) continue;
      const descriptor = Buffer.alloc(8);
      if (
        !adv.symbols.ConvertStringSecurityDescriptorToSecurityDescriptorW(
          wide(next),
          1,
          descriptor,
          null,
        )
      )
        continue;
      try {
        // SetFileSecurityW, unlike SetNamedSecurityInfoW, never re-walks
        // the children: a profile-sized tree is untouched.
        adv.symbols.SetFileSecurityW(wide(parent), 4, address(descriptor));
      } finally {
        kernel.symbols.LocalFree(address(descriptor));
      }
    }
  };
  const readDacl = (path: string): string | undefined => {
    const needed = Buffer.alloc(4);
    adv.symbols.GetFileSecurityW(wide(path), 4, null, 0, needed);
    const size = needed.readUInt32LE();
    if (!size) return undefined;
    const sd = Buffer.alloc(size);
    if (!adv.symbols.GetFileSecurityW(wide(path), 4, sd, size, needed))
      return undefined;
    const out = Buffer.alloc(8);
    if (
      !adv.symbols.ConvertSecurityDescriptorToStringSecurityDescriptorW(
        sd,
        1,
        4,
        out,
        null,
      )
    )
      return undefined;
    try {
      return readWide(address(out), 1 << 16);
    } finally {
      kernel.symbols.LocalFree(address(out));
    }
  };
  // PowerShell (and cmd's cd/dir) stat every parent of the working folder,
  // which the AppContainer may not do above its own workspace. Map the
  // workspace to its own drive letter and start there: no parents to stat.
  // The letter lives in this logon session only and is removed after the
  // run. Fail open: without a free letter the run starts in the real path.
  const mapDrive = (): { root: string; remove(): void } | null => {
    const RAW = 1,
      REMOVE = 2,
      EXACT = 4,
      QUIET = 8;
    const targets = (letter: string) => {
      const out = Buffer.alloc(65536);
      const n = kernel.symbols.QueryDosDeviceW(wide(letter), out, 32768);
      return n ? out.toString("utf16le", 0, n * 2).split("\0").filter(Boolean) : [];
    };
    const target = `\\??\\${workspace}`;
    const mutex = kernel.symbols.CreateMutexW(null, false, wide("Local\\phantombot-sandbox-drive"));
    if (mutex) kernel.symbols.WaitForSingleObject(mutex, 5000);
    try {
      const used = kernel.symbols.GetLogicalDrives();
      // Letters left by a killed launcher point at deleted workspaces.
      for (let i = 3; i < 26; i++) {
        if (!(used & (1 << i))) continue;
        const letter = `${String.fromCharCode(65 + i)}:`;
        const old = targets(letter);
        if (isStaleSandboxDrive(old, existsSync))
          kernel.symbols.DefineDosDeviceW(RAW | REMOVE | EXACT | QUIET, wide(letter), wide(old[0]!));
      }
      for (const letter of freeDriveLetters(kernel.symbols.GetLogicalDrives())) {
        if (!kernel.symbols.DefineDosDeviceW(RAW | QUIET, wide(letter), wide(target))) continue;
        const now = targets(letter);
        const remove = () =>
          kernel.symbols.DefineDosDeviceW(RAW | REMOVE | EXACT | QUIET, wide(letter), wide(target));
        if (now.length === 1 && now[0]!.toLowerCase() === target.toLowerCase())
          return { root: `${letter}\\`, remove };
        remove(); // someone else's letter appeared meanwhile
      }
      return null;
    } catch {
      return null;
    } finally {
      if (mutex) {
        kernel.symbols.ReleaseMutex(mutex);
        kernel.symbols.CloseHandle(mutex);
      }
    }
  };
  const name = wide(windowsProfileName(given));
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
  const netSidOut = Buffer.alloc(8);
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
    // Anything that loads user32 (PowerShell, git, whoami) dies with
    // STATUS_DLL_INIT_FAILED unless the AppContainer can open its window
    // station and desktop. Give each run a private pair it alone may use;
    // both vanish with their last handle, so nothing on the host changes.
    // Fail open (never deny service): without a private desktop the run
    // still starts, as before, just without user32 tools.
    let surface: { name: Buffer | null; close(): void };
    try {
      surface = privateDesktop(sid);
    } catch {
      surface = { name: null, close() {} };
    }
    // Windows tools (PowerShell, git, cmd's cd/dir) stat every parent of
    // their working folder. One fixed capability may read those parents'
    // attributes (this folder only: no listing, no reading, no inheritance)
    // the workspace's parents; granted once and idempotent, never per turn.
    const drive = mapDrive();
    const traverse = traverseCapability();
    try {
      grantParents(workspace, traverse.text);
    } catch {
      // Best effort: a parent we may not change (C:\\, another user's root) stays as is.
    }
    const size = Buffer.alloc(8);
    kernel.symbols.InitializeProcThreadAttributeList(null, 2, 0, size);
    const attrs = Buffer.alloc(address(size));
    check(
      kernel.symbols.InitializeProcThreadAttributeList(attrs, 2, 0, size),
      "process attributes",
    );
    // GHSA-w7w8: untrusted turns need outbound network. internetClient
    // (S-1-15-3-1) only: AppContainer still cannot reach the host's loopback.
    check(
      adv.symbols.ConvertStringSidToSidW(wide("S-1-15-3-1"), netSidOut),
      "network capability",
    );
    const capabilityList = Buffer.alloc(32);
    capabilityList.writeBigUInt64LE(netSidOut.readBigUInt64LE());
    capabilityList.writeUInt32LE(4, 8); // SE_GROUP_ENABLED
    capabilityList.writeBigUInt64LE(BigInt(traverse.sid), 16);
    capabilityList.writeUInt32LE(4, 24);
    const capabilities = Buffer.alloc(24);
    capabilities.writeBigUInt64LE(BigInt(sid));
    capabilities.writeBigUInt64LE(BigInt(ptr(capabilityList)), 8);
    capabilities.writeUInt32LE(2, 16);
    const handles = Buffer.alloc(24),
      startup = Buffer.alloc(112),
      info = Buffer.alloc(24);
    startup.writeUInt32LE(112);
    startup.writeUInt32LE(0x100, 60);
    startup.writeBigUInt64LE(BigInt(ptr(attrs)), 104);
    if (surface.name)
      startup.writeBigUInt64LE(BigInt(ptr(surface.name)), 16); // lpDesktop
    // The handle list must not repeat a handle (Win32 87 when stdout and
    // stderr are one handle, e.g. `2>&1` to a file).
    const listed: bigint[] = [];
    for (let i = 0; i < 3; i++) {
      const handle = kernel.symbols.GetStdHandle(-10 - i);
      check(handle, "stdio handle");
      check(
        kernel.symbols.SetHandleInformation(handle, 1, 1),
        "stdio inheritance",
      );
      const value = BigInt(Number(handle));
      if (!listed.includes(value)) {
        handles.writeBigUInt64LE(value, listed.length * 8);
        listed.push(value);
      }
      startup.writeBigUInt64LE(value, 80 + i * 8);
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
          listed.length * 8,
          null,
          null,
        ),
        "stdio-only handle list",
      );
      // The launcher env carries the persona secrets (runSandbox); forward
      // them. sandboxEnvironment drops reserved names and keeps fixed values.
      const env = sandboxEnvironment(workspace, home, process.env, [], sandboxContextFromEnv(process.env));
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
          wide(drive?.root ?? workspace),
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
      surface.close();
      drive?.remove();
    }
  } finally {
    if (address(netSidOut)) kernel.symbols.LocalFree(address(netSidOut));
    traverseFree?.();
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

/**
 * True when the NUL device's DACL lets AppContainers (ALL APPLICATION
 * PACKAGES) read and write it. git (and most MSYS/mingw tools) open NUL on
 * every start, so without this grant they cannot run inside the sandbox.
 * Windows 11 26H2 (build 26300) grants it; Server 2022/2025 and Windows 11
 * 24H2 (build 26100) and older do not, and only an admin could change that.
 */
export function nulGrantsAppContainers(sddl: string): boolean {
  const dacl = sddl.split(/S:/)[0] ?? "";
  for (const m of dacl.matchAll(/\(A;[^;()]*;([^;()]*);;;(AC|S-1-15-2-1)\)/gi)) {
    const rights = m[1]!.toUpperCase();
    if (/^(FA|GA)$/.test(rights) || (rights.includes("GR") && rights.includes("GW")))
      return true;
    const hex = /^0X([0-9A-F]+)$/.exec(rights);
    if (hex && (parseInt(hex[1]!, 16) & 0x3) === 0x3) return true;
  }
  return false;
}

let appContainerUsable: boolean | undefined;
/** Test seam only: forces the NUL check result (undefined = real check). */
export function setWindowsAppContainerUsableForTests(v: boolean | undefined): void {
  appContainerUsable = v;
}

/** Reads NUL's DACL once per process; fails open (false) on any error. */
export function windowsAppContainerUsable(): boolean {
  if (appContainerUsable !== undefined) return appContainerUsable;
  // Forcing ON only makes runs stricter (CI exercises the shipped launcher on
  // builds whose NUL is closed). PHANTOMBOT_ is reserved: secrets can't set it.
  if (process.env.PHANTOMBOT_WINDOWS_APPCONTAINER === "force")
    return (appContainerUsable = true);
  appContainerUsable = false;
  if (process.platform !== "win32") return appContainerUsable;
  try {
    const k = dlopen("kernel32.dll", {
      CreateFileW: {
        args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "ptr"],
        returns: "ptr",
      },
      CloseHandle: { args: ["ptr"], returns: "bool" },
      LocalFree: { args: ["ptr"], returns: "ptr" },
    });
    const a = dlopen("advapi32.dll", {
      GetSecurityInfo: {
        args: ["ptr", "u32", "u32", "ptr", "ptr", "ptr", "ptr", "ptr"],
        returns: "u32",
      },
      ConvertSecurityDescriptorToStringSecurityDescriptorW: {
        args: ["ptr", "u32", "u32", "ptr", "ptr"],
        returns: "bool",
      },
    });
    // READ_CONTROL, share all, OPEN_EXISTING.
    const h = k.symbols.CreateFileW(wide("\\\\.\\NUL"), 0x20000, 7, null, 3, 0, null);
    if (!h || Number(h) === -1) return appContainerUsable;
    try {
      const sd = Buffer.alloc(8);
      // SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION.
      if (a.symbols.GetSecurityInfo(h, 6, 4, null, null, null, null, sd) !== 0)
        return appContainerUsable;
      try {
        const text = Buffer.alloc(8);
        if (
          !a.symbols.ConvertSecurityDescriptorToStringSecurityDescriptorW(
            address(sd),
            1,
            4,
            text,
            null,
          )
        )
          return appContainerUsable;
        try {
          appContainerUsable = nulGrantsAppContainers(readWide(address(text), 1 << 16));
        } finally {
          k.symbols.LocalFree(address(text));
        }
      } finally {
        k.symbols.LocalFree(address(sd));
      }
    } finally {
      k.symbols.CloseHandle(h);
    }
  } catch {
    /* fail open: unsandboxed */
  }
  return appContainerUsable;
}
