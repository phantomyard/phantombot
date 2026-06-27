/*
 * oggOpusDurationSeconds: walks an Ogg/Opus container and derives playback
 * length from the last page's 48 kHz granule position minus the OpusHead
 * pre-skip. These tests build minimal-but-valid Ogg pages so the parser's math
 * is pinned without shipping a binary fixture.
 */
import { describe, expect, test } from "bun:test";
import {
  oggOpusDurationSeconds,
  oggOpusWaveformBase64,
} from "../src/channels/phantomchat/oggOpusDuration.ts";

/**
 * Mirror of the PWA's `decodeWaveform` (phantomchat audio.ts) — proves the bytes
 * we pack decode back to the same 5-bit values the bubble renderer reads.
 */
function decodeWaveform(bytes: Uint8Array): number[] {
  const valueCount = ((bytes.length * 8) / 5) | 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: number[] = [];
  for (let i = 0; i < valueCount; i++) {
    const byteIndex = ((i * 5) / 8) | 0;
    const bitShift = (i * 5) % 8;
    // getUint16 may read one byte past the end on the final value; pad to be safe.
    const lo = bytes[byteIndex] ?? 0;
    const hi = bytes[byteIndex + 1] ?? 0;
    const value = lo | (hi << 8);
    out.push((value >> bitShift) & 0x1f);
    void view;
  }
  return out;
}

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

describe("oggOpusWaveformBase64", () => {
  test("returns '' for non-Ogg input", () => {
    expect(oggOpusWaveformBase64(Buffer.from("nope"))).toBe("");
    expect(oggOpusWaveformBase64(Buffer.alloc(0))).toBe("");
  });

  test("tracks packet sizes: loud frames peak, quiet frames dip", () => {
    // Two header pages (OpusHead + a tags stand-in) get dropped, then an audio
    // page whose 4 segments alternate quiet/loud (10 vs 200 bytes).
    const head = oggPage(0n, 0x02, [opusHead(0)]);
    const tags = oggPage(0n, 0x00, [Buffer.alloc(8, 0)]);
    const audio = oggPage(BigInt(48000), 0x04, [
      Buffer.alloc(10, 1),
      Buffer.alloc(200, 1),
      Buffer.alloc(10, 1),
      Buffer.alloc(200, 1),
    ]);
    const b64 = oggOpusWaveformBase64(Buffer.concat([head, tags, audio]), 4);
    expect(b64.length).toBeGreaterThan(0);
    const values = decodeWaveform(new Uint8Array(Buffer.from(b64, "base64")));
    // 4 buckets, nearest-neighbour: quiet, loud, quiet, loud.
    // 200 normalises to 31; 10/200*31 ≈ 1.55 → 2.
    expect(values.slice(0, 4)).toEqual([2, 31, 2, 31]);
  });

  test("packs the default 100 bars into 63 bytes", () => {
    const head = oggPage(0n, 0x02, [opusHead(0)]);
    const tags = oggPage(0n, 0x00, [Buffer.alloc(8, 0)]);
    const segs = Array.from({ length: 20 }, (_, i) => Buffer.alloc(20 + i * 5, 1));
    const audio = oggPage(BigInt(48000), 0x04, segs);
    const b64 = oggOpusWaveformBase64(Buffer.concat([head, tags, audio]));
    const bytes = Buffer.from(b64, "base64");
    expect(bytes.length).toBe(Math.ceil((100 * 5) / 8)); // 63
    // Every bar is filled (nearest-neighbour upsampling, no comb gaps) and the
    // peak normalises to the full 5-bit range.
    const values = decodeWaveform(new Uint8Array(bytes));
    expect(Math.max(...values)).toBe(31);
  });
});
