/**
 * Windows Job Object support for process-tree ownership.
 *
 * A PID walk (`taskkill /T`) is inherently racy: a child can escape between
 * enumeration and termination, or a recycled PID can identify a new process.
 * JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE gives the parent an OS-owned lifetime
 * boundary instead. This module is deliberately a no-op off Windows.
 */

import { dlopen, FFIType } from "bun:ffi";

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;

interface Kernel32 {
  CreateJobObjectW: (attributes: null, name: null) => unknown;
  SetInformationJobObject: (
    job: unknown,
    infoClass: number,
    info: Uint8Array,
    infoLength: number,
  ) => boolean;
  OpenProcess: (access: number, inherit: boolean, pid: number) => unknown;
  AssignProcessToJobObject: (job: unknown, process: unknown) => boolean;
  CloseHandle: (handle: unknown) => boolean;
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
      CreateJobObjectW: {
        args: [FFIType.ptr, FFIType.ptr],
        returns: FFIType.ptr,
      },
      SetInformationJobObject: {
        args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32],
        returns: FFIType.bool,
      },
      OpenProcess: {
        args: [FFIType.u32, FFIType.bool, FFIType.u32],
        returns: FFIType.ptr,
      },
      AssignProcessToJobObject: {
        args: [FFIType.ptr, FFIType.ptr],
        returns: FFIType.bool,
      },
      CloseHandle: {
        args: [FFIType.ptr],
        returns: FFIType.bool,
      },
    });
    kernel32 = lib.symbols as unknown as Kernel32;
  } catch {
    // Keep the process-group fallback usable on older/unsupported runtimes.
    kernel32 = null;
  }
  return kernel32;
}

export interface WindowsJob {
  assign(pid: number): boolean;
  close(): void;
}

/** Create a kill-on-close job, or null when the host cannot provide one. */
export function createWindowsJob(): WindowsJob | null {
  const api = loadKernel32();
  if (!api) return null;

  const job = api.CreateJobObjectW(null, null);
  if (!job) return null;

  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on supported Windows
  // ABIs. LimitFlags is the third field of the nested basic structure at byte
  // offset 16; zero-fill preserves every other limit.
  const info = new Uint8Array(144);
  new DataView(info.buffer).setUint32(16, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true);
  if (!api.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, info, info.byteLength)) {
    api.CloseHandle(job);
    return null;
  }

  let closed = false;
  return {
    assign(pid) {
      if (closed || !Number.isInteger(pid) || pid <= 0) return false;
      const processHandle = api.OpenProcess(
        PROCESS_SET_QUOTA | PROCESS_TERMINATE,
        false,
        pid,
      );
      if (!processHandle) return false;
      try {
        return api.AssignProcessToJobObject(job, processHandle);
      } finally {
        api.CloseHandle(processHandle);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      api.CloseHandle(job);
    },
  };
}
