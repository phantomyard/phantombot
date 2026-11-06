/** Applied only in a clean self-exec child, immediately before exec. No compiler. */
import { sendListener } from "./linux-notify.ts";
import { dlopen, ptr } from "bun:ffi";
import { realpathSync } from "node:fs";

export function linuxSandbox(
  workspace: string,
  executable: string,
  argv: string[],
): never {
  if (process.arch !== "x64" && process.arch !== "arm64")
    throw new Error("unsupported sandbox architecture");
  const lib = dlopen("libc.so.6", {
    syscall: {
      args: ["i64", "i64", "i64", "i64", "i64", "i64", "i64"],
      returns: "i64",
    },
    prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" },
    open: { args: ["cstring", "i32"], returns: "i32" },
    close: { args: ["i32"], returns: "i32" },
    execv: { args: ["cstring", "ptr"], returns: "i32" },
    setrlimit: { args: ["i32", "ptr"], returns: "i32" },
  });
  const cstr = (s: string) => Buffer.from(s + "\0");
  const syscall = (nr: number, ...args: number[]) =>
    Number(
      lib.symbols.syscall(
        nr,
        ...(Array.from({ length: 6 }, (_, i) => args[i] ?? 0) as [
          number,
          number,
          number,
          number,
          number,
          number,
        ]),
      ),
    );
  const check = (value: number, operation: string) => {
    if (value < 0) throw new Error(`sandbox unavailable: ${operation}`);
    return value;
  };
  const abi = check(syscall(444, 0, 0, 1), "Landlock");
  // ABI 3 handles REFER and TRUNCATE. No optimistic downgrade to weaker rules.
  if (abi < 3) throw new Error("sandbox unavailable: Landlock ABI 3 required");
  const handled = (1 << 15) - 1; // all filesystem rights through TRUNCATE
  const ruleSet = Buffer.alloc(8);
  ruleSet.writeBigUInt64LE(BigInt(handled));
  const fd = check(syscall(444, ptr(ruleSet), 8, 0), "create ruleset");
  const read = (1 << 0) | (1 << 2) | (1 << 3); // execute, read file, read dir
  const add = (path: string, access: number, required = false) => {
    let resolved: string;
    try {
      resolved = realpathSync(path);
    } catch {
      if (required) throw new Error(`sandbox path missing: ${path}`);
      return;
    }
    const p = check(
      lib.symbols.open(cstr(resolved), 0x200000 | 0x80000),
      "open sandbox path",
    ); // O_PATH | O_CLOEXEC
    const rule = Buffer.alloc(12);
    rule.writeBigUInt64LE(BigInt(access));
    rule.writeInt32LE(p, 8);
    try {
      check(syscall(445, fd, 1, ptr(rule), 0), "add path rule");
    } finally {
      lib.symbols.close(p);
    }
  };
  // Runtime files, not the host's home, /proc, /run, or all of /etc.
  for (const p of [
    "/usr/bin",
    "/usr/sbin",
    "/usr/lib",
    "/usr/lib64",
    "/usr/libexec",
    "/usr/include",
    "/usr/share",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
  ])
    add(p, read);
  for (const p of [
    "/etc/ld.so.cache",
    "/etc/localtime",
    "/proc/stat",
    "/sys/devices/system/cpu/online",
  ])
    add(p, 1 << 2);
  for (const p of ["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom"])
    add(p, (1 << 1) | (1 << 2));
  add(workspace, handled, true);
  add(executable, (1 << 0) | (1 << 2), true);
  // A fresh environment is supplied by the parent. Nothing besides stdio may
  // survive exec (in particular no host socket or directory descriptor).
  const capHeader = Buffer.alloc(8),
    capData = Buffer.alloc(24);
  capHeader.writeUInt32LE(0x20080522);
  check(
    syscall(process.arch === "x64" ? 126 : 91, ptr(capHeader), ptr(capData)),
    "drop capabilities",
  );
  check(lib.symbols.prctl(38, 1, 0, 0, 0), "no_new_privs");
  check(syscall(446, fd, 0), "restrict self");
  lib.symbols.close(fd);
  const limit = (resource: number, value: number) => {
    const data = Buffer.alloc(16);
    data.writeBigUInt64LE(BigInt(value));
    data.writeBigUInt64LE(BigInt(value), 8);
    check(lib.symbols.setrlimit(resource, data), "resource limit");
  };
  limit(0, 120);
  limit(1, 1024 * 1024 * 1024);
  limit(4, 0);
  limit(6, 4096);
  limit(7, 4096);
  // BPF checks the ABI first (including the x32 bit), then denies host IPC,
  // networking, process inspection and escaping the process group. A fork
  // inherits these restrictions; clone3 cannot hide namespace flags in a pointer.
  const x64 = process.arch === "x64";
  const blocked = x64
    ? [
        41, 42, 43, 49, 50, 62, 141, 142, 144, 203, 314, 101, 103, 109, 112,
        154, 165, 166, 167, 168, 169, 172, 173, 200, 234, 248, 249, 250, 272,
        298, 300, 303, 304, 308, 310, 311, 312, 321, 323, 424, 425, 426, 427,
        428, 429, 430, 431, 432, 433, 434, 438, 440, 442, 443, 448, 449, 450,
        451, 452, 453, 454, 455, 456, 457, 458, 459, 460, 461, 462, 463, 464,
        465, 466,
      ]
    : [
        198, 203, 200, 201, 202, 129, 140, 118, 119, 122, 274, 117, 116, 154,
        157, 39, 40, 224, 225, 142, 130, 131, 217, 218, 219, 97, 241, 262, 264,
        265, 268, 270, 271, 272, 280, 282, 424, 425, 426, 427, 428, 429, 430,
        431, 432, 433, 434, 438, 440, 442, 443, 448, 449, 450, 451, 452, 453,
        454, 455, 456, 457, 458, 459, 460, 461, 462, 463, 464, 465, 466,
      ];
  // SysV IPC (not path-mediated by Landlock).
  blocked.push(
    ...(x64
      ? [29, 30, 31, 64, 65, 66, 67, 68, 69, 70, 71]
      : [186, 187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197]),
  );
  const instructions: [number, number, number, number][] = [
    [0x20, 0, 0, 4],
    [0x15, 1, 0, x64 ? 0xc000003e : 0xc00000b7],
    [0x06, 0, 0, 0x80000000],
    [0x20, 0, 0, 0],
    [0x45, 0, 1, 0x40000000],
    [0x06, 0, 0, 0x80000000],
    [0x15, 0, 1, 435],
    [0x06, 0, 0, 0x00050000 | 38], // ENOSYS clone3: libc falls back
  ];
  for (const nr of new Set(blocked))
    instructions.push([0x15, 0, 1, nr], [0x06, 0, 0, 0x00050000 | 1]);
  // prlimit64(pid!=0) could lower another host process's limits.
  instructions.push(
    [0x15, 0, 3, x64 ? 302 : 261],
    [0x20, 0, 0, 16],
    [0x15, 1, 0, 0],
    [0x06, 0, 0, 0x00050000 | 1],
    [0x20, 0, 0, 0],
  );
  for (const nr of x64 ? [2, 257, 437] : [56, 437])
    instructions.push([0x15, 0, 1, nr], [0x06, 0, 0, 0x7fc00000]);
  // Reject namespace flags on old clone; ordinary threads/forks still work.
  instructions.push(
    [0x15, 0, 3, x64 ? 56 : 220],
    [0x20, 0, 0, 16],
    [0x45, 0, 1, 0x7e020080],
    [0x06, 0, 0, 0x00050000 | 1],
  );
  instructions.push([0x06, 0, 0, 0x7fff0000]);
  const filter = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, jt, jf, k], i) => {
    filter.writeUInt16LE(code, i * 8);
    filter[i * 8 + 2] = jt;
    filter[i * 8 + 3] = jf;
    filter.writeUInt32LE(k, i * 8 + 4);
  });
  const prog = Buffer.alloc(16);
  prog.writeUInt16LE(instructions.length);
  prog.writeBigUInt64LE(BigInt(ptr(filter)), 8);
  const listener = check(
    syscall(x64 ? 317 : 277, 1, 8, ptr(prog)),
    "seccomp notification",
  );
  sendListener(listener);
  check(syscall(436, 3, 0xffffffff, 0), "close inherited descriptors");
  const words = [executable, ...argv].map(cstr);
  const pointers = Buffer.alloc((words.length + 1) * 8);
  words.forEach((word, i) =>
    pointers.writeBigUInt64LE(BigInt(ptr(word)), i * 8),
  );
  lib.symbols.execv(cstr(executable), pointers);
  throw new Error("sandbox exec failed");
}
