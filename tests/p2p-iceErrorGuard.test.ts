import { describe, expect, it } from "bun:test";
import { isBenignIceSocketError } from "../src/p2p/iceErrorGuard.ts";

/** Build a Node-style system error the way dgram surfaces one. */
function sysError(code: string, syscall: string): Error {
  const e = new Error(`${code}: ${syscall} failed`) as Error & {
    code?: string;
    syscall?: string;
  };
  e.code = code;
  e.syscall = syscall;
  return e;
}

describe("isBenignIceSocketError", () => {
  it("absorbs the observed crash: ECONNREFUSED on recv", () => {
    // The exact shape that was crash-looping Lena mid-handshake.
    expect(isBenignIceSocketError(sysError("ECONNREFUSED", "recv"))).toBe(true);
  });

  it("absorbs the family of unreachable UDP codes on send/recv", () => {
    for (const code of ["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET", "EPERM"]) {
      for (const syscall of ["recv", "send", "recvmsg", "sendmsg"]) {
        expect(isBenignIceSocketError(sysError(code, syscall))).toBe(true);
      }
    }
  });

  it("does NOT absorb a real application error", () => {
    expect(isBenignIceSocketError(new Error("something broke"))).toBe(false);
  });

  it("does NOT absorb an unreachable code from a non-dgram syscall", () => {
    // ECONNREFUSED from a TCP connect() is a real failure we must not swallow.
    expect(isBenignIceSocketError(sysError("ECONNREFUSED", "connect"))).toBe(false);
  });

  it("does NOT absorb an unrelated code on a dgram syscall", () => {
    expect(isBenignIceSocketError(sysError("EACCES", "recv"))).toBe(false);
  });

  it("is null/undefined/primitive safe", () => {
    expect(isBenignIceSocketError(null)).toBe(false);
    expect(isBenignIceSocketError(undefined)).toBe(false);
    expect(isBenignIceSocketError("ECONNREFUSED")).toBe(false);
  });
});
