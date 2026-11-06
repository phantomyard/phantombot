/** Narrow /proc compatibility broker. All other opens still face Landlock. */
import { dlopen, ptr } from "bun:ffi";
import { openSync, readSync, closeSync } from "node:fs";

export function socketPair(): [number, number] {
  const lib = dlopen("libc.so.6", {
    socketpair: { args: ["i32", "i32", "i32", "ptr"], returns: "i32" },
  });
  const pair = Buffer.alloc(8);
  try {
    if (lib.symbols.socketpair(1, 1 | 0x80000, 0, pair) < 0)
      throw new Error("sandbox supervisor socket unavailable");
    return [pair.readInt32LE(), pair.readInt32LE(4)];
  } finally {
    lib.close();
  }
}
/** Transfer the seccomp listener once, before exec and before closing fd 3. */
export function sendListener(listener: number): void {
  const lib = dlopen("libc.so.6", {
    sendmsg: { args: ["i32", "ptr", "i32"], returns: "i64" },
  });
  const byte = Buffer.from([1]),
    iov = Buffer.alloc(16),
    control = Buffer.alloc(24),
    msg = Buffer.alloc(56);
  iov.writeBigUInt64LE(BigInt(ptr(byte)));
  iov.writeBigUInt64LE(1n, 8);
  control.writeBigUInt64LE(20n);
  control.writeInt32LE(1, 8);
  control.writeInt32LE(1, 12);
  control.writeInt32LE(listener, 16);
  msg.writeBigUInt64LE(BigInt(ptr(iov)), 16);
  msg.writeBigUInt64LE(1n, 24);
  msg.writeBigUInt64LE(BigInt(ptr(control)), 32);
  msg.writeBigUInt64LE(24n, 40);
  try {
    if (Number(lib.symbols.sendmsg(3, msg, 0)) !== 1)
      throw new Error("sandbox listener transfer failed");
  } finally {
    lib.close();
  }
}
export function receiveListener(socket: number): number | undefined {
  const lib = dlopen("libc.so.6", {
    recvmsg: { args: ["i32", "ptr", "i32"], returns: "i64" },
  });
  const byte = Buffer.alloc(1),
    iov = Buffer.alloc(16),
    control = Buffer.alloc(24),
    msg = Buffer.alloc(56);
  iov.writeBigUInt64LE(BigInt(ptr(byte)));
  iov.writeBigUInt64LE(1n, 8);
  msg.writeBigUInt64LE(BigInt(ptr(iov)), 16);
  msg.writeBigUInt64LE(1n, 24);
  msg.writeBigUInt64LE(BigInt(ptr(control)), 32);
  msg.writeBigUInt64LE(24n, 40);
  try {
    const n = Number(lib.symbols.recvmsg(socket, msg, 0x40 | 0x40000000));
    if (n < 0) return undefined;
    if (
      n !== 1 ||
      control.readBigUInt64LE() !== 20n ||
      control.readInt32LE(8) !== 1 ||
      control.readInt32LE(12) !== 1
    )
      throw new Error("sandbox listener missing");
    return control.readInt32LE(16);
  } finally {
    lib.close();
  }
}
/** Bounded native poll; yields between batches to keep the runtime responsive. */
export async function superviseProc(
  listener: number,
  stopped: () => boolean,
): Promise<void> {
  const lib = dlopen("libc.so.6", {
    ioctl: { args: ["i32", "u64", "ptr"], returns: "i32" },
    poll: { args: ["ptr", "u64", "i32"], returns: "i32" },
    fcntl: { args: ["i32", "i32", "i32"], returns: "i32" },
  });
  lib.symbols.fcntl(listener, 4, 0x800); // O_NONBLOCK
  const poll = Buffer.alloc(8);
  poll.writeInt32LE(listener);
  poll.writeInt16LE(1, 4);
  let iterations = 0;
  try {
    while (!stopped()) {
      if (++iterations % 16 === 0) await Bun.sleep(0);
      const ready = lib.symbols.poll(poll, 1, 1);
      if (ready <= 0) {
        await Bun.sleep(0);
        continue;
      }
      if (!(poll.readInt16LE(6) & 1)) break;
      const note = Buffer.alloc(80);
      if (lib.symbols.ioctl(listener, 0xc0502100, note) < 0) {
        await Bun.sleep(0);
        continue;
      }
      const id = note.readBigUInt64LE(),
        pid = note.readUInt32LE(8),
        nr = note.readInt32LE(16);
      const offset = nr === (process.arch === "x64" ? 2 : -1) ? 32 : 40;
      const pointer = Number(note.readBigUInt64LE(offset));
      let path = "";
      try {
        const mem = openSync(`/proc/${pid}/mem`, "r");
        try {
          const bytes = Buffer.alloc(4096);
          const n = readSync(mem, bytes, 0, bytes.length, pointer);
          const end = bytes.subarray(0, n).indexOf(0);
          if (end >= 0) path = bytes.toString("utf8", 0, end);
        } finally {
          closeSync(mem);
        }
      } catch {
        /* continue: Landlock still enforces the actual open */
      }
      const match =
        /^\/proc\/(?:self|thread-self)\/(maps|statm|status|stat|limits|cgroup)$/.exec(
          path,
        );
      if (match) {
        let source: number | undefined;
        try {
          source = openSync(`/proc/${pid}/${match[1]}`, "r");
          const add = Buffer.alloc(24);
          add.writeBigUInt64LE(id);
          add.writeUInt32LE(2, 8);
          add.writeUInt32LE(source, 12);
          add.writeUInt32LE(0x80000, 20);
          if (lib.symbols.ioctl(listener, 0x40182103, add) >= 0) continue;
        } catch {
          /* reply below; no broad /proc permission */
        } finally {
          if (source !== undefined) closeSync(source);
        }
        const response = Buffer.alloc(24);
        response.writeBigUInt64LE(id);
        response.writeInt32LE(-13, 16);
        lib.symbols.ioctl(listener, 0xc0182101, response);
      } else {
        // CONTINUE never bypasses Landlock, including a changed path pointer.
        const response = Buffer.alloc(24);
        response.writeBigUInt64LE(id);
        response.writeUInt32LE(1, 20);
        lib.symbols.ioctl(listener, 0xc0182101, response);
      }
    }
  } finally {
    closeSync(listener);
    lib.close();
  }
}
