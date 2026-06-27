/*
 * oggOpusDurationSeconds: walks an Ogg/Opus container and derives playback
 * length from the last page's 48 kHz granule position minus the OpusHead
 * pre-skip. These tests build minimal-but-valid Ogg pages so the parser's math
 * is pinned without shipping a binary fixture.
 */
import { describe, expect, test } from "bun:test";
import { oggOpusDurationSeconds } from "../src/channels/phantomchat/oggOpusDuration.ts";

/** Build one Ogg page. Each segment payload must be < 255 bytes (no lacing). */
function oggPage(granule: bigint, headerType: number, segments: Buffer[]): Buffer {
  const header = Buffer.alloc(27);
  header.write("OggS", 0, "latin1");
  header[4] = 0; // stream structure version
  header[5] = headerType; // 0x02 BOS, 0x04 EOS
  header.writeBigUInt64LE(granule, 6);
  // serial (14), page seq (18), CRC (22) left zero — parser ignores them.
  header[26] = segments.length;
  const segTable = Buffer.from(segments.map((s) => s.length));
  return Buffer.concat([header, segTable, ...segments]);
}

/** OpusHead identification packet with the given pre-skip (LE u16 at +10). */
function opusHead(preSkip: number): Buffer {
  const head = Buffer.alloc(19);
  head.write("OpusHead", 0, "latin1");
  head[8] = 1; // version
  head[9] = 1; // channel count
  head.writeUInt16LE(preSkip, 10);
  head.writeUInt32LE(48000, 12); // input sample rate
  head.writeUInt16LE(0, 16); // output gain
  head[18] = 0; // channel mapping family
  return head;
}

describe("oggOpusDurationSeconds", () => {
  test("derives duration from last granule minus pre-skip", () => {
    const preSkip = 312;
    const head = oggPage(0n, 0x02, [opusHead(preSkip)]);
    // 3 audible seconds => 3*48000 samples + preSkip in the granule.
    const last = oggPage(BigInt(3 * 48000 + preSkip), 0x04, [Buffer.alloc(10, 1)]);
    expect(oggOpusDurationSeconds(Buffer.concat([head, last]))).toBe(3);
  });

  test("rounds to nearest whole second", () => {
    const preSkip = 0;
    const head = oggPage(0n, 0x02, [opusHead(preSkip)]);
    // 2.7s -> rounds to 3
    const last = oggPage(BigInt(Math.round(2.7 * 48000)), 0x04, [Buffer.alloc(5, 9)]);
    expect(oggOpusDurationSeconds(Buffer.concat([head, last]))).toBe(3);
  });

  test("never rounds a non-empty clip down to zero", () => {
    const head = oggPage(0n, 0x02, [opusHead(0)]);
    // 0.2s -> Math.round would give 0; clamped to 1.
    const last = oggPage(BigInt(Math.round(0.2 * 48000)), 0x04, [Buffer.alloc(3, 7)]);
    expect(oggOpusDurationSeconds(Buffer.concat([head, last]))).toBe(1);
  });

  test("ignores -1 granule pages (no completed packet)", () => {
    const head = oggPage(0n, 0x02, [opusHead(0)]);
    const real = oggPage(BigInt(48000), 0x00, [Buffer.alloc(8, 2)]);
    const noPacket = oggPage(0xffffffffffffffffn, 0x00, [Buffer.alloc(4, 3)]);
    expect(oggOpusDurationSeconds(Buffer.concat([head, real, noPacket]))).toBe(1);
  });

  test("returns 0 for non-Ogg input", () => {
    expect(oggOpusDurationSeconds(Buffer.from("not an ogg stream at all"))).toBe(0);
    expect(oggOpusDurationSeconds(Buffer.alloc(0))).toBe(0);
  });
});
