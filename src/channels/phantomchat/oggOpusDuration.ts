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
