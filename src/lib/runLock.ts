/**
 * Single-instance lock for `phantombot run` (and `phantombot tick`).
 *
 * Prevents two phantombot processes from racing each other on the same
 * Telegram bot token — two pollers on one token trigger getUpdates 409 spam and
 * make every turn run (and every state-changing action fire) twice.
 *
 * ── Why this is an OS ADVISORY lock, not a PID file (2026-08-10) ──
 * The previous implementation was a lock FILE plus a PID-liveness heuristic:
 * write our PID, and on a pre-existing file decide whether the recorded holder
 * is still alive (reclaim if not). Every version of that design sprouted a fresh
 * time-of-check/time-of-use race — three in a row — because "is the holder
 * alive?" and "reclaim the file" can never be made atomic with respect to a
 * second starter. Aligned boot+logon starts (exactly Megan's trigger) kept
 * ending up with two live daemons.
 *
 * The fix is to stop reconstructing "one holder per token" from a file and let
 * the KERNEL enforce it. We hold an exclusive advisory lock on the lock file for
 * the entire process lifetime:
 *   - POSIX:   flock(fd, LOCK_EX | LOCK_NB)
 *   - Windows: LockFileEx(handle, EXCLUSIVE | FAIL_IMMEDIATELY, …)
 * The lock is bound to the open file description / file handle, so the OS
 * releases it AUTOMATICALLY when the holder exits — including a hard kill
 * (`taskkill /F`, SIGKILL, crash), which is how the daemon dies on every Windows
 * stop / restart / self-update. There is no "stale lock" state to reclaim and no
 * liveness heuristic to race: acquisition either succeeds (we are the sole
 * holder) or fails immediately (someone else holds it). That collapses the whole
 * TOCTOU class into a single kernel invariant.
 *
 * ── The PID in the file is INFORMATIONAL only ──
 * After acquiring the lock we write our PID into the file purely so a conflicting
 * starter can print "already running (pid N)". Correctness never depends on the
 * file's contents — only on holding the OS lock. On Windows the lock lives at a
 * high sentinel byte offset (LOCK_OFFSET_*), so a conflicting process can still
 * read the PID bytes at offset 0 even though the file is exclusively locked.
 *
 * ── We never delete the lock file ──
 * release() drops the OS lock and closes the handle; it does NOT unlink the
 * file. Deleting it would reintroduce a race: unlink + re-create hands out a new
 * inode, and two starters straddling the unlink could each flock a different
 * inode and both "win". Leaving the file in place keeps the path↔inode mapping
 * stable so flock always coordinates on the same object. The file lives in
 * tmpfs ($XDG_RUNTIME_DIR) or %TEMP% and is reaped on reboot; a stale PID inside
 * it is harmless because nothing reads it for a correctness decision.
 *
 * ── Multi-user ──
 * The lock path is user-scoped ($XDG_RUNTIME_DIR / per-uid /tmp on POSIX,
 * per-account %TEMP% on Windows), so two users starting their own phantom at
 * boot never share a lock file and never block each other.
 */

import { dlopen, FFIType } from "bun:ffi";
import {
  closeSync,
  constants,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface LockHandle {
  /** Path to the lock file. */
  path: string;
  /** Release the lock — drops the OS lock and closes the handle. Idempotent. */
  release: () => void;
}

export interface LockConflict {
  /** Path the lock lives at. */
  path: string;
  /** PID recorded by the holder (NaN if not yet written / unreadable). */
  pid: number;
}

export function defaultLockPath(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) return join(xdg, "phantombot.run.lock");
  // Windows has no XDG_RUNTIME_DIR and no uid. `os.tmpdir()` resolves to the
  // per-user %TEMP% (…\AppData\Local\Temp), which is already user-scoped, so a
  // single filename there won't collide across accounts the way /tmp would.
  if (process.platform === "win32") {
    return join(tmpdir(), "phantombot.run.lock");
  }
  // No XDG_RUNTIME_DIR (e.g. a non-systemd login): fall back to a user-scoped
  // dir under $HOME, NOT /tmp (issue #365) — a full/quota'd tmpfs must never be
  // able to block the lock. Still per-user (not per-persona), so two personas
  // sharing one OS user can't spawn two daemons on the same token.
  const uid = process.getuid?.() ?? 0;
  const runDir = join(homedir(), ".cache", "phantombot", "run");
  mkdirSync(runDir, { recursive: true });
  return join(runDir, `phantombot-${uid}.run.lock`);
}

/** Informational payload: our PID, so a conflicting starter can name us. */
function lockPayload(): string {
  return `${process.pid}\n`;
}

/**
 * Best-effort read of the holder's PID for the conflict message. Purely
 * cosmetic — correctness comes from the OS lock, never from this value. Returns
 * NaN when the file is empty (holder hasn't written its PID yet) or unreadable.
 */
function readHolderPid(path: string): number {
  try {
    const first = (readFileSync(path, "utf8").split("\n")[0] ?? "").trim();
    const n = Number(first);
    return Number.isInteger(n) && n > 0 ? n : NaN;
  } catch {
    return NaN;
  }
}

/**
 * Try to acquire the single-instance lock. Returns a LockHandle on success or a
 * LockConflict when another process already holds it.
 */
export function acquireRunLock(path: string): LockHandle | LockConflict {
  mkdirSync(dirname(path), { recursive: true });
  return process.platform === "win32"
    ? acquireWindowsLock(path)
    : acquirePosixLock(path);
}

// ─────────────────────────────── POSIX (flock) ───────────────────────────────

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

interface Libc {
  flock: (fd: number, operation: number) => number;
}

let libc: Libc | null | undefined;

function loadLibc(): Libc | null {
  if (libc !== undefined) return libc;
  if (process.platform === "win32") {
    libc = null;
    return libc;
  }
  // flock(2) lives in libc on every supported POSIX target.
  const candidates =
    process.platform === "darwin"
      ? ["libSystem.B.dylib", "libc.dylib"]
      : ["libc.so.6", "libc.so"];
  for (const name of candidates) {
    try {
      const lib = dlopen(name, {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      });
      libc = lib.symbols as unknown as Libc;
      return libc;
    } catch {
      /* try next candidate */
    }
  }
  libc = null;
  return libc;
}

function acquirePosixLock(path: string): LockHandle | LockConflict {
  const api = loadLibc();
  if (!api) return fallbackAcquire(path);

  // O_CLOEXEC so the lock fd never leaks into spawned children (a lingering
  // child holding the inherited fd would keep the lock alive after the daemon
  // dies — exactly what we must avoid).
  let flags = constants.O_CREAT | constants.O_RDWR;
  // O_CLOEXEC isn't in the fs constants type but exists at runtime on Linux/mac.
  const cloexec = (constants as Record<string, number>).O_CLOEXEC;
  if (typeof cloexec === "number") flags |= cloexec;
  const fd = openSync(path, flags, 0o600);

  // LOCK_NB means the only expected failure on a valid fd is "held". Retry a
  // couple of times to ride out a rare EINTR; a genuinely held lock stays -1 and
  // we fail closed (report the conflict) rather than risk a second daemon.
  let rc = -1;
  for (let i = 0; i < 3; i++) {
    rc = api.flock(fd, LOCK_EX | LOCK_NB);
    if (rc === 0) break;
  }
  if (rc !== 0) {
    const pid = readHolderPid(path);
    try {
      closeSync(fd);
    } catch {
      /* fine */
    }
    return { path, pid };
  }

  // We hold the lock. Record our PID (informational). flock is advisory, so this
  // separate write never conflicts with a reader.
  try {
    ftruncateSync(fd, 0);
    writeSync(fd, lockPayload(), 0, "utf8");
  } catch {
    /* PID is cosmetic; the lock is what matters */
  }

  let released = false;
  return {
    path,
    release: () => {
      if (released) return;
      released = true;
      try {
        api.flock(fd, LOCK_UN);
      } catch {
        /* closing the fd releases it anyway */
      }
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    },
  };
}

// ────────────────────────────── Windows (LockFileEx) ─────────────────────────

const GENERIC_READ = 0x8000_0000;
const GENERIC_WRITE = 0x4000_0000;
const FILE_SHARE_READ = 0x0000_0001;
const FILE_SHARE_WRITE = 0x0000_0002;
const OPEN_ALWAYS = 4;
const FILE_ATTRIBUTE_NORMAL = 0x0000_0080;
const LOCKFILE_FAIL_IMMEDIATELY = 0x0000_0001;
const LOCKFILE_EXCLUSIVE_LOCK = 0x0000_0002;
const INVALID_HANDLE_VALUE = 0xffff_ffff_ffff_ffffn;

// Lock a single byte at a high sentinel offset (well beyond any real file size).
// Locking beyond EOF is legal on Windows and keeps offset 0 — where we store the
// informational PID — readable by a conflicting starter.
const LOCK_OFFSET_LOW = 0x4000_0000;
const LOCK_OFFSET_HIGH = 0;

interface Kernel32 {
  CreateFileW: (
    name: Uint8Array,
    access: number,
    share: number,
    security: null,
    disposition: number,
    flags: number,
    template: null,
  ) => bigint;
  LockFileEx: (
    handle: bigint,
    flags: number,
    reserved: number,
    bytesLow: number,
    bytesHigh: number,
    overlapped: Uint8Array,
  ) => number;
  WriteFile: (
    handle: bigint,
    buffer: Uint8Array,
    bytes: number,
    written: Uint8Array,
    overlapped: null,
  ) => number;
  SetEndOfFile: (handle: bigint) => number;
  CloseHandle: (handle: bigint) => number;
}

let kernel32: Kernel32 | null | undefined;

function loadKernel32(): Kernel32 | null {
  if (kernel32 !== undefined) return kernel32;
  if (process.platform !== "win32") {
    kernel32 = null;
    return kernel32;
  }
  try {
    const lib = dlopen("kernel32.dll", {
      CreateFileW: {
        args: [
          FFIType.ptr,
          FFIType.u32,
          FFIType.u32,
          FFIType.ptr,
          FFIType.u32,
          FFIType.u32,
          FFIType.ptr,
        ],
        returns: FFIType.u64,
      },
      LockFileEx: {
        args: [
          FFIType.u64,
          FFIType.u32,
          FFIType.u32,
          FFIType.u32,
          FFIType.u32,
          FFIType.ptr,
        ],
        returns: FFIType.i32,
      },
      WriteFile: {
        args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
      SetEndOfFile: { args: [FFIType.u64], returns: FFIType.i32 },
      CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    });
    kernel32 = lib.symbols as unknown as Kernel32;
  } catch {
    kernel32 = null;
  }
  return kernel32;
}

function acquireWindowsLock(path: string): LockHandle | LockConflict {
  const api = loadKernel32();
  if (!api) return fallbackAcquire(path);

  const name = Buffer.from(`${path}\0`, "utf16le");
  const handle = api.CreateFileW(
    name,
    // JS bitwise-OR yields a SIGNED int32; 0x80000000|0x40000000 is negative
    // and Bun's FFI drops a negative value when marshaling to a u32 arg, which
    // opens the handle with dwDesiredAccess=0 (no write/lock rights → WriteFile
    // and LockFileEx fail with ERROR_ACCESS_DENIED). `>>> 0` coerces to unsigned.
    (GENERIC_READ | GENERIC_WRITE) >>> 0,
    FILE_SHARE_READ | FILE_SHARE_WRITE,
    null,
    OPEN_ALWAYS,
    FILE_ATTRIBUTE_NORMAL,
    null,
  );
  if (handle === 0n || handle === INVALID_HANDLE_VALUE) {
    // Couldn't even open the file — degrade rather than wedge startup.
    return fallbackAcquire(path);
  }

  const overlapped = new Uint8Array(32); // OVERLAPPED (x64): 32 bytes
  const dv = new DataView(overlapped.buffer);
  dv.setUint32(16, LOCK_OFFSET_LOW, true); // OVERLAPPED.Offset
  dv.setUint32(20, LOCK_OFFSET_HIGH, true); // OVERLAPPED.OffsetHigh

  const locked = api.LockFileEx(
    handle,
    LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
    0,
    1,
    0,
    overlapped,
  );
  if (!locked) {
    // Held by someone else (FAIL_IMMEDIATELY ⇒ ERROR_LOCK_VIOLATION). Read the
    // informational PID at offset 0 for the conflict message, then let go.
    const pid = readHolderPid(path);
    api.CloseHandle(handle);
    return { path, pid };
  }

  // We hold the lock. Write our PID at offset 0 (outside the locked region) so a
  // conflicting starter can name us, and truncate any stale bytes.
  try {
    const payload = Buffer.from(lockPayload(), "utf8");
    const written = new Uint8Array(4);
    api.WriteFile(handle, payload, payload.byteLength, written, null);
    api.SetEndOfFile(handle);
  } catch {
    /* PID is cosmetic */
  }

  let released = false;
  return {
    path,
    release: () => {
      if (released) return;
      released = true;
      // Closing the handle releases every lock held on it.
      try {
        api.CloseHandle(handle);
      } catch {
        /* already closed */
      }
    },
  };
}

// ─────────────────────────────── Degraded fallback ───────────────────────────

/**
 * Only reached when neither libc (POSIX) nor kernel32 (Windows) can be loaded —
 * i.e. essentially never on our real targets. Falls back to an O_EXCL create
 * with no kernel-backed lock. This DOES unlink on release (unlike the advisory
 * path) because there is no OS lock to inherit, so the classic unlink race
 * doesn't apply and a leftover file would otherwise wedge startup permanently.
 */
function fallbackAcquire(path: string): LockHandle | LockConflict {
  try {
    const fd = openSync(path, "wx"); // O_CREAT | O_EXCL
    writeSync(fd, lockPayload());
    closeSync(fd);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      return { path, pid: readHolderPid(path) };
    }
    throw e;
  }
  let released = false;
  return {
    path,
    release: () => {
      if (released) return;
      released = true;
      try {
        if (readHolderPid(path) === process.pid) unlinkSync(path);
      } catch {
        /* already gone */
      }
    },
  };
}

/** Type guard. */
export function isLockHandle(r: LockHandle | LockConflict): r is LockHandle {
  return typeof (r as LockHandle).release === "function";
}

/** Used by tests to check if a file is locked without actually creating it. */
export { existsSync as _lockFileExists } from "node:fs";
