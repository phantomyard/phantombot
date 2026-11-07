/**
 * Windows: untrusted scratch lives under `<SystemDrive>\phantom-sandbox`, not
 * in the user's profile, and needs no administrator.
 *
 * PowerShell and git stat every parent of their working folder. An
 * AppContainer may not stat `C:\Users` or anything else above its own folder,
 * and only an administrator can change that. git never stats the drive root,
 * so a scratch tree directly under `C:\` that this user creates (Authenticated
 * Users may add folders to `C:\` by default) and whose ACLs this user owns is
 * enough: each folder on the way down carries one read-attributes ACE for the
 * fixed traverse capability every sandbox holds (see windows.ts). The
 * launcher maps the workspace to a drive letter as well, so PowerShell sees no
 * parents at all.
 *
 * Layout: `C:\phantom-sandbox\<user SID>\<persona>-<hash>\` replaces
 * `<persona>\scratch\untrusted\` through a junction, so scratch.ts, the
 * session's containment checks and teardown keep working unchanged. The user
 * folder is private to that user (protected DACL); the shared root lets users
 * add their own folder but not list anyone else's.
 *
 * Fail open: any failure (no right to create folders in `C:\`, a squatted user
 * folder, a busy scratch dir) leaves the profile scratch in place, where
 * PowerShell and cmd still work and git is limited to network-only commands.
 */
import { dlopen, read, type Pointer } from "bun:ffi";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, win32 } from "node:path";

export const WINDOWS_SANDBOX_ROOT = "phantom-sandbox";
/** Fixed per-host capability every sandbox carries. */
export const TRAVERSE_CAPABILITY = "phantombotSandboxTraverse";
/** SYNCHRONIZE | FILE_READ_ATTRIBUTES: stat only; no list, no read. */
export const TRAVERSE_MASK = "0x100080";
/**
 * Authenticated Users on the shared root, this folder only: traverse, add a
 * subfolder, read attributes and the DACL. No listing, so no user learns
 * which other users have a folder there.
 */
const ROOT_USERS_MASK = "0x1200a4";

export function sandboxRootSddl(capability: string): string {
  return (
    "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICIIO;FA;;;CO)" +
    `(A;;${ROOT_USERS_MASK};;;AU)(A;;${TRAVERSE_MASK};;;${capability})`
  );
}

/** Private to `user` (plus SYSTEM and Administrators), inherited below. */
export function sandboxUserSddl(user: string, capability: string): string {
  return (
    `D:P(A;OICI;FA;;;${user})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)` +
    `(A;;${TRAVERSE_MASK};;;${capability})`
  );
}

/** `<drive>\phantom-sandbox\<user SID>\<persona>-<hash of the persona dir>`. */
export function windowsScratchTarget(
  systemDrive: string,
  userSid: string,
  agentDir: string,
): string {
  const drive = systemDrive.replace(/[\\/]+$/, "");
  const persona =
    win32.basename(agentDir).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40) ||
    "persona";
  const tag = createHash("sha256")
    .update(agentDir.toLowerCase())
    .digest("hex")
    .slice(0, 12);
  return `${drive}\\${WINDOWS_SANDBOX_ROOT}\\${userSid}\\${persona}-${tag}`;
}

let api: ReturnType<typeof loadApi> | undefined;
function loadApi() {
  const adv = dlopen("advapi32.dll", {
    ConvertStringSecurityDescriptorToSecurityDescriptorW: {
      args: ["ptr", "u32", "ptr", "ptr"],
      returns: "bool",
    },
    ConvertSecurityDescriptorToStringSecurityDescriptorW: {
      args: ["ptr", "u32", "u32", "ptr", "ptr"],
      returns: "bool",
    },
    GetFileSecurityW: { args: ["ptr", "u32", "ptr", "u32", "ptr"], returns: "bool" },
    SetFileSecurityW: { args: ["ptr", "u32", "ptr"], returns: "bool" },
    OpenProcessToken: { args: ["ptr", "u32", "ptr"], returns: "bool" },
    GetTokenInformation: { args: ["ptr", "u32", "ptr", "u32", "ptr"], returns: "bool" },
    ConvertSidToStringSidW: { args: ["ptr", "ptr"], returns: "bool" },
  });
  const kernel = dlopen("kernel32.dll", {
    GetCurrentProcess: { args: [], returns: "ptr" },
    CloseHandle: { args: ["ptr"], returns: "bool" },
    LocalFree: { args: ["ptr"], returns: "ptr" },
    GetLastError: { args: [], returns: "u32" },
  });
  const base = dlopen("kernelbase.dll", {
    DeriveCapabilitySidsFromName: {
      args: ["ptr", "ptr", "ptr", "ptr", "ptr"],
      returns: "bool",
    },
  });
  const wide = (s: string) => Buffer.from(s + "\0", "utf16le");
  const address = (b: Buffer, at = 0) => Number(b.readBigUInt64LE(at)) as Pointer;
  const readWide = (p: Pointer, max = 1 << 16) => {
    let out = "";
    for (let at = 0; at < max; at += 2) {
      const unit = read.u16(p, at);
      if (unit === 0) break;
      out += String.fromCharCode(unit);
    }
    return out;
  };
  const check = (ok: unknown, what: string) => {
    if (!ok) throw new Error(`${what} (Win32 ${kernel.symbols.GetLastError()})`);
  };
  const sidString = (sid: Pointer) => {
    const out = Buffer.alloc(8);
    check(adv.symbols.ConvertSidToStringSidW(sid, out), "SID string");
    try {
      return readWide(address(out));
    } finally {
      kernel.symbols.LocalFree(address(out));
    }
  };
  return {
    userSid(): string {
      const token = Buffer.alloc(8);
      check(
        adv.symbols.OpenProcessToken(kernel.symbols.GetCurrentProcess(), 0x8, token),
        "process token",
      );
      try {
        const info = Buffer.alloc(256),
          used = Buffer.alloc(4);
        check(
          adv.symbols.GetTokenInformation(address(token), 1, info, 256, used),
          "token user",
        );
        return sidString(address(info));
      } finally {
        kernel.symbols.CloseHandle(address(token));
      }
    },
    capabilitySid(): string {
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
      try {
        check(sidCount.readUInt32LE() >= 1, "traverse capability SID");
        return sidString(read.ptr(address(sids), 0) as Pointer);
      } finally {
        free(groups, groupCount);
        free(sids, sidCount);
      }
    },
    /** SDDL of one part of `path`'s descriptor (1 = owner, 4 = DACL). */
    descriptor(path: string, part: number): string {
      const needed = Buffer.alloc(4);
      adv.symbols.GetFileSecurityW(wide(path), part, null, 0, needed);
      const size = needed.readUInt32LE();
      check(size, `read security of ${path}`);
      const sd = Buffer.alloc(size);
      check(
        adv.symbols.GetFileSecurityW(wide(path), part, sd, size, needed),
        `read security of ${path}`,
      );
      const out = Buffer.alloc(8);
      check(
        adv.symbols.ConvertSecurityDescriptorToStringSecurityDescriptorW(
          sd,
          1,
          part,
          out,
          null,
        ),
        "descriptor string",
      );
      try {
        return readWide(address(out));
      } finally {
        kernel.symbols.LocalFree(address(out));
      }
    },
    /** Replace the DACL. SetFileSecurityW never re-walks children. */
    setDacl(path: string, sddl: string): void {
      const sd = Buffer.alloc(8);
      check(
        adv.symbols.ConvertStringSecurityDescriptorToSecurityDescriptorW(
          wide(sddl),
          1,
          sd,
          null,
        ),
        "DACL descriptor",
      );
      try {
        check(adv.symbols.SetFileSecurityW(wide(path), 4, address(sd)), `set DACL of ${path}`);
      } finally {
        kernel.symbols.LocalFree(address(sd));
      }
    },
  };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
let warned = false;

/**
 * Make `<persona>\scratch\untrusted` a junction into `C:\phantom-sandbox`.
 * Idempotent and cheap when already in place. Never throws: on any failure
 * the profile scratch stays (fail open) and one line is logged.
 */
export function prepareWindowsUntrustedScratch(
  untrustedRoot: string,
  agentDir: string,
): boolean {
  if (process.platform !== "win32") return false;
  try {
    const w = (api ??= loadApi());
    const user = w.userSid();
    const drive = process.env.SystemDrive || "C:";
    const target = windowsScratchTarget(drive, user, agentDir);
    try {
      if (same(realpathSync(untrustedRoot), realpathSync(target))) return true;
    } catch {
      /* not linked yet */
    }
    const capability = w.capabilitySid();
    const root = `${drive.replace(/[\\/]+$/, "")}\\${WINDOWS_SANDBOX_ROOT}`;
    if (mkdirIfMissing(root)) w.setDacl(root, sandboxRootSddl(capability));
    const userDir = join(root, user);
    mkdirIfMissing(userDir);
    // Another user may have created (squatted) this folder: never use it.
    // An elevated process's new folders are owned by Administrators.
    const owner = w.descriptor(userDir, 1);
    if (!same(owner, `O:${user}`) && !same(owner, "O:BA"))
      throw new Error(`${userDir} is not owned by this user`);
    w.setDacl(userDir, sandboxUserSddl(user, capability));
    mkdirSync(target, { recursive: true });
    let current: ReturnType<typeof lstatSync> | undefined;
    try {
      current = lstatSync(untrustedRoot);
    } catch {
      mkdirSync(dirname(untrustedRoot), { recursive: true });
    }
    if (current) {
      // A real dir still holding a running turn's files: switch next time.
      if (!current.isSymbolicLink() && readdirSync(untrustedRoot).length)
        return false;
      rmdirSync(untrustedRoot); // empty dir, or a stale junction (not followed)
    }
    symlinkSync(target, untrustedRoot, "junction");
    return true;
  } catch (error) {
    if (!warned) {
      warned = true;
      console.warn(
        `phantombot: sandbox scratch stays in the profile (${(error as Error).message}); ` +
          "PowerShell works there, git only for network commands",
      );
    }
    return false;
  }
}

function mkdirIfMissing(path: string): boolean {
  try {
    mkdirSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}
