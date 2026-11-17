/** Small, dependency-free media validation helpers. Never trust a client MIME claim without checking the file signature. */
export function detectMediaType(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf.length >= 12 && buf.toString("ascii", 4, 8) === "ftyp") return buf.toString("ascii", 8, 12) === "qt  " ? "video/quicktime" : "video/mp4";
  return null;
}

/** Remove common location-bearing metadata without re-encoding image pixels. */
export function stripImageMetadata(buf: Buffer, contentType: string): Buffer {
  if (contentType === "image/jpeg") {
    if (detectMediaType(buf) !== contentType) throw new Error("invalid_image_signature");
    const parts: Buffer[] = [buf.subarray(0, 2)];
    let pos = 2;
    while (pos < buf.length) {
      if (buf[pos] !== 0xff) { parts.push(buf.subarray(pos)); break; }
      const start = pos;
      while (pos < buf.length && buf[pos] === 0xff) pos++;
      if (pos >= buf.length) { parts.push(buf.subarray(start)); break; }
      const marker = buf[pos++];
      if (marker === 0xda || marker === 0xd9) { parts.push(buf.subarray(start)); break; }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { parts.push(buf.subarray(start, pos)); continue; }
      if (pos + 2 > buf.length) throw new Error("invalid_jpeg_segment");
      const length = buf.readUInt16BE(pos), end = pos + length;
      if (length < 2 || end > buf.length) throw new Error("invalid_jpeg_segment");
      // APP1 contains EXIF/XMP; APP13 commonly carries IPTC location metadata.
      if (marker !== 0xe1 && marker !== 0xed) parts.push(buf.subarray(start, end));
      pos = end;
    }
    return Buffer.concat(parts);
  }
  if (contentType === "image/png") {
    if (detectMediaType(buf) !== contentType) throw new Error("invalid_image_signature");
    const parts: Buffer[] = [buf.subarray(0, 8)];
    let pos = 8;
    while (pos + 12 <= buf.length) {
      const size = buf.readUInt32BE(pos), type = buf.toString("ascii", pos + 4, pos + 8), end = pos + size + 12;
      if (end > buf.length) throw new Error("invalid_png_chunk");
      // eXIf and text/time chunks can contain GPS and other identifying metadata.
      if (!["eXIf", "tEXt", "zTXt", "iTXt", "tIME"].includes(type)) parts.push(buf.subarray(pos, end));
      pos = end;
      if (type === "IEND") break;
    }
    if (pos !== buf.length) parts.push(buf.subarray(pos));
    return Buffer.concat(parts);
  }
  if (contentType === "image/webp") {
    if (detectMediaType(buf) !== contentType) throw new Error("invalid_image_signature");
    const chunks: Buffer[] = [];
    let pos = 12, vp8x: Buffer | null = null;
    while (pos + 8 <= buf.length) {
      const type = buf.toString("ascii", pos, pos + 4), size = buf.readUInt32LE(pos + 4), end = pos + 8 + size + (size & 1);
      if (end > buf.length) throw new Error("invalid_webp_chunk");
      const chunk = Buffer.from(buf.subarray(pos, end));
      if (type === "VP8X") vp8x = chunk;
      if (type !== "EXIF" && type !== "XMP ") chunks.push(chunk);
      pos = end;
    }
    if (pos !== buf.length) throw new Error("invalid_webp_container");
    if (vp8x && vp8x.length >= 9) vp8x[8] &= ~0x0c; // clear EXIF and XMP feature flags
    const out = Buffer.concat([buf.subarray(0, 12), ...chunks]);
    out.writeUInt32LE(out.length - 8, 4);
    return out;
  }
  throw new Error("unsupported_image_type");
}

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 120 * 1024 * 1024;
export const MAX_VIDEO_DURATION_MS = 120_000;

export function validVideoProbe(probe: unknown, maxDurationMs = MAX_VIDEO_DURATION_MS): { durationMs: number; width: number | null; height: number | null } | null {
  if (!probe || typeof probe !== "object") return null;
  const p = probe as { format?: { duration?: string | number }; streams?: Array<{ codec_type?: string; width?: number; height?: number }> };
  const duration = Number(p.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration * 1000 > maxDurationMs) return null;
  const video = p.streams?.find(s => s.codec_type === "video");
  if (!video) return null;
  const width = Number(video.width), height = Number(video.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > 12000 || height > 12000) return null;
  return { durationMs: Math.round(duration * 1000), width, height };
}
