/**
 * Compute the playback duration (in seconds) of an Ogg/Opus stream.
 *
 * Opus granule positions run on a fixed 48 kHz clock (RFC 7845 §4),
 * independent of the originally-encoded sample rate. The total decoded sample
 * count is the granule position of the LAST Ogg page; subtracting the pre-skip
 * declared in the OpusHead identification header gives the audible sample
 * count. Duration = audibleSamples / 48000.
 *
 * This is a tiny container walk — no decode — so it's cheap to run on every
 * voice reply. Returns 0 for anything that isn't a parseable Ogg/Opus stream;
 * callers treat 0 as "unknown duration" and simply omit the field.
 */
export function oggOpusDurationSeconds(buf: Buffer): number {
  const OGGS = 0x4f676753; // "OggS" capture pattern, big-endian
  const GRANULE_NONE = 0xffffffffffffffffn; // -1 → no packet completed on page

  // Pre-skip: little-endian u16 at OpusHead + 10
  // (magic[8] + version[1] + channelCount[1] = offset 10).
  let preSkip = 0;
  const headIdx = buf.indexOf("OpusHead", 0, "latin1");
  if (headIdx >= 0 && headIdx + 12 <= buf.length) {
    preSkip = buf.readUInt16LE(headIdx + 10);
  }

  // Walk Ogg pages to find the last valid granule position.
  let lastGranule = -1;
  for (let i = 0; i + 27 <= buf.length; ) {
    if (buf.readUInt32BE(i) === OGGS) {
      const granule = buf.readBigUInt64LE(i + 6);
      const segCount = buf[i + 26] ?? 0;
      const headerEnd = i + 27 + segCount;
      if (headerEnd > buf.length) break;
      let payload = 0;
      for (let s = 0; s < segCount; s++) payload += buf[i + 27 + s] ?? 0;
      if (granule !== GRANULE_NONE) lastGranule = Number(granule);
      i = headerEnd + payload;
    } else {
      i++;
    }
  }

  if (lastGranule < 0) return 0;
  const samples = Math.max(0, lastGranule - preSkip);
  if (samples === 0) return 0;
  // Voice-note duration is conventionally whole seconds; never round a
  // non-empty clip down to 0.
  return Math.max(1, Math.round(samples / 48000));
}

/**
 * Pack an array of 5-bit amplitude values (0–31) into the little-endian bit
 * layout Telegram's waveform decoder expects. The PWA reads each value back
 * with `getUint16(byteIndex, little-endian) >> (i*5 % 8) & 0x1f`
 * (phantomchat audio.ts `decodeWaveform`), so the encoder must mirror that:
 * value `i` occupies the 5 bits starting at bit position `i*5`, low bits
 * first, spilling into the next byte when it straddles a boundary.
 */
function packWaveform5bit(values: number[]): Buffer {
  const out = Buffer.alloc(Math.ceil((values.length * 5) / 8));
  for (let i = 0; i < values.length; i++) {
    const v = (values[i] ?? 0) & 0x1f;
    const bit = i * 5;
    const idx = bit >> 3;
    const shift = bit & 7;
    out[idx] = (out[idx] ?? 0) | ((v << shift) & 0xff);
    if (shift > 3 && idx + 1 < out.length) {
      out[idx + 1] = (out[idx + 1] ?? 0) | (v >> (8 - shift));
    }
  }
  return out;
}

/**
 * Derive a Telegram-style waveform envelope from an Ogg/Opus stream and return
 * it base64-encoded for the voice-note metadata `waveform` field.
 *
 * We approximate per-instant loudness from Opus *packet sizes*: at constant
 * bitrate the encoder spends more bytes on busy speech and fewer on near-silence
 * (DTX), so the lacing values in the Ogg segment table track the speech rhythm
 * closely enough for a visual hint — and reading them is a cheap container walk,
 * no audio decode. The result is resampled to `bars` buckets, normalised to the
 * 5-bit 0–31 range, and packed the way the PWA decoder reads it back.
 *
 * Returns "" for anything that isn't a parseable Ogg/Opus stream; callers treat
 * "" as "no waveform" and simply omit the field (bubble still shows length).
 */
export function oggOpusWaveformBase64(buf: Buffer, bars = 100): string {
  const OGGS = 0x4f676753; // "OggS" capture pattern, big-endian
  const sizes: number[] = [];
  for (let i = 0; i + 27 <= buf.length; ) {
    if (buf.readUInt32BE(i) === OGGS) {
      const segCount = buf[i + 26] ?? 0;
      const headerEnd = i + 27 + segCount;
      if (headerEnd > buf.length) break;
      let payload = 0;
      for (let s = 0; s < segCount; s++) {
        const lace = buf[i + 27 + s] ?? 0;
        // 255 is a lacing continuation marker (packet > 255 bytes), not an
        // independent amplitude — skip so it doesn't spike the envelope.
        if (lace !== 255) sizes.push(lace);
        payload += lace;
      }
      i = headerEnd + payload;
    } else {
      i++;
    }
  }

  // Drop the two non-audio header packets (OpusHead, OpusTags) — each is the
  // sole segment of its own page, so they're the first two lacing values.
  const audio = sizes.slice(2);
  if (audio.length === 0) return "";

  // Resample to `bars` buckets by nearest-neighbour so every bar is filled even
  // for short clips (averaging would leave comb-like gaps when audio.length < bars).
  const buckets: number[] = new Array(bars).fill(0);
  for (let b = 0; b < bars; b++) {
    const idx = Math.min(audio.length - 1, Math.floor((b * audio.length) / bars));
    buckets[b] = audio[idx] ?? 0;
  }

  const max = Math.max(...buckets);
  if (max <= 0) return "";
  const values = buckets.map((v) => Math.round((v / max) * 31));
  return packWaveform5bit(values).toString("base64");
}
