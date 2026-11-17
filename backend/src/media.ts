import { Router } from "express";
import express from "express";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, unlink, writeFile, rename, stat, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { pool } from "./db.ts";
import { requireRole, rateLimit } from "./auth.ts";
import { adminOnly } from "./adminAuth.ts";
import { detectMediaType, stripImageMetadata, validVideoProbe, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, MAX_VIDEO_DURATION_MS } from "./mediaRules.ts";

export const media = Router();
const member = requireRole("individual", "collector");
const allowed = new Set(["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime"]);
const storageDir = () => path.resolve(process.env.MEDIA_STORAGE_DIR || path.join(process.cwd(), "private-media"));
const execFileAsync = promisify(execFile);
const secret = () => process.env.MEDIA_SIGNING_SECRET || process.env.JWT_SECRET || "";

function signature(assetId: string, viewerPublicId: string, expires: number) {
  return createHmac("sha256", secret()).update(`${assetId}:${viewerPublicId}:${expires}`).digest("hex");
}
export function signedMediaUrl(assetId: string | number, viewerPublicId: string) {
  const id = String(assetId), expires = Math.floor(Date.now() / 1000) + 300;
  const base = (process.env.MEDIA_PUBLIC_ORIGIN || "").replace(/\/$/, "");
  return `${base}/v1/media/${encodeURIComponent(id)}?u=${encodeURIComponent(viewerPublicId)}&e=${expires}&s=${signature(id, viewerPublicId, expires)}`;
}
function isValidSignature(id: string, viewer: string, expiresRaw: unknown, sigRaw: unknown) {
  const expires = Number(expiresRaw), sig = String(sigRaw ?? "");
  if (!Number.isSafeInteger(expires) || expires <= Math.floor(Date.now() / 1000) || expires > Math.floor(Date.now() / 1000) + 600 || !/^[a-f0-9]{64}$/.test(sig)) return false;
  const expected = Buffer.from(signature(id, viewer, expires));
  const actual = Buffer.from(sig);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
const mediaType = (kind: string, contentType: string) => kind === "image" ? contentType.startsWith("image/") : contentType.startsWith("video/");

media.post("/media/uploads", member, rateLimit(12, 60_000), async (req, res) => {
  const b = z.object({
    kind: z.enum(["image", "video"]), contentType: z.string(), byteSize: z.number().int().positive(),
    width: z.number().int().positive().max(12000).optional(), height: z.number().int().positive().max(12000).optional(),
    durationMs: z.number().int().positive().max(120000).optional(),
  }).safeParse(req.body);
  if (!b.success || !allowed.has(b.data.contentType) || !mediaType(b.data.kind, b.data.contentType)) return res.status(400).json({ error: "invalid_media_metadata" });
  const max = b.data.kind === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (b.data.byteSize > max || (b.data.kind === "image" && b.data.durationMs)) return res.status(413).json({ error: "media_limits_exceeded" });
  const key = randomUUID();
  const r = await pool.query(`INSERT INTO media_assets(owner_id,storage_key,media_kind,content_type,byte_size,width,height,duration_ms)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id::text`, [req.auth!.sub, key, b.data.kind, b.data.contentType, b.data.byteSize, b.data.width ?? null, b.data.height ?? null, b.data.durationMs ?? null]);
  res.status(201).json({ assetId: r.rows[0].id, uploadPath: `/v1/media/uploads/${r.rows[0].id}`, maxBytes: max, maxDurationMs: MAX_VIDEO_DURATION_MS });
});

// Raw binary upload; the JSON parser installed by server.ts ignores non-JSON content types.
media.put("/media/uploads/:id", member, rateLimit(8, 60_000), express.raw({ type: "*/*", limit: "125mb" }), async (req, res) => {
  const id = /^\d{1,18}$/.test(req.params.id) ? req.params.id : null;
  if (!id || !Buffer.isBuffer(req.body)) return res.status(400).json({ error: "invalid_upload" });
  const r = await pool.query(`SELECT id,storage_key,media_kind,content_type,byte_size FROM media_assets
    WHERE id=$1 AND owner_id=$2 AND status='pending' AND created_at>now()-interval '30 minutes'`, [id, req.auth!.sub]);
  if (!r.rowCount) return res.status(404).json({ error: "upload_not_found_or_expired" });
  const asset = r.rows[0] as { storage_key: string; media_kind: string; content_type: string; byte_size: number };
  const buf = req.body as Buffer, contentType = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (buf.length !== Number(asset.byte_size) || contentType !== asset.content_type || detectMediaType(buf) !== asset.content_type) return res.status(400).json({ error: "media_content_mismatch" });
  await mkdir(storageDir(), { recursive: true, mode: 0o700 });
  const target = path.join(storageDir(), asset.storage_key), inputTemp = `${target}.upload`, outputTemp = `${target}.processed`;
  let finalBytes: Buffer, actualDuration: number | null = null, actualWidth: number | null = null, actualHeight: number | null = null;
  try {
    if (asset.media_kind === "image") {
      // Strip EXIF, XMP, IPTC, PNG text/time and WebP EXIF/XMP chunks before the file is made visible.
      finalBytes = stripImageMetadata(buf, asset.content_type);
      await writeFile(target, finalBytes, { flag: "wx", mode: 0o600 });
    } else {
      // Client-provided duration is only an early UX hint. ffprobe measures the actual container/stream.
      await writeFile(inputTemp, buf, { flag: "wx", mode: 0o600 });
      const ffprobe = process.env.MEDIA_FFPROBE_PATH || "ffprobe";
      const ffmpeg = process.env.MEDIA_FFMPEG_PATH || "ffmpeg";
      const probeArgs = ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json"];
      const first = JSON.parse((await execFileAsync(ffprobe, [...probeArgs, inputTemp], { maxBuffer: 2 * 1024 * 1024 })).stdout);
      const measured = validVideoProbe(first);
      if (!measured) { await unlink(inputTemp).catch(() => {}); return res.status(413).json({ error: "video_duration_or_dimensions_exceeded" }); }
      const format = asset.content_type === "video/quicktime" ? "mov" : "mp4";
      await execFileAsync(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", inputTemp,
        "-map", "0:v?", "-map", "0:a?", "-map_metadata", "-1", "-map_metadata:s", "-1", "-c", "copy", "-f", format, outputTemp], { maxBuffer: 2 * 1024 * 1024 });
      const finalProbe = JSON.parse((await execFileAsync(ffprobe, [...probeArgs, outputTemp], { maxBuffer: 2 * 1024 * 1024 })).stdout);
      const checked = validVideoProbe(finalProbe);
      if (!checked) { await unlink(inputTemp).catch(() => {}); await unlink(outputTemp).catch(() => {}); return res.status(415).json({ error: "video_processing_failed" }); }
      const outputStat = await stat(outputTemp);
      if (outputStat.size <= 0 || outputStat.size > MAX_VIDEO_BYTES) { await unlink(inputTemp).catch(() => {}); await unlink(outputTemp).catch(() => {}); return res.status(413).json({ error: "media_limits_exceeded" }); }
      await rename(outputTemp, target);
      await unlink(inputTemp).catch(() => {});
      finalBytes = await readFile(target);
      actualDuration = checked.durationMs; actualWidth = checked.width; actualHeight = checked.height;
    }
  } catch (error) {
    await Promise.all([unlink(inputTemp).catch(() => {}), unlink(outputTemp).catch(() => {}), unlink(target).catch(() => {})]);
    if (asset.media_kind === "video") return res.status(503).json({ error: "video_processing_unavailable", detail: "Install FFmpeg and FFprobe on the API host and configure MEDIA_FFMPEG_PATH / MEDIA_FFPROBE_PATH if needed." });
    return res.status(400).json({ error: "image_metadata_processing_failed" });
  }
  const digest = createHash("sha256").update(finalBytes).digest("hex");
  await pool.query(`UPDATE media_assets SET status='ready',sha256=$2,byte_size=$3,
      duration_ms=COALESCE($4,duration_ms),width=COALESCE($5,width),height=COALESCE($6,height),uploaded_at=now()
    WHERE id=$1 AND owner_id=$7 AND status='pending'`, [id, digest, finalBytes.length, actualDuration, actualWidth, actualHeight, req.auth!.sub]);
  res.json({ ok: true, assetId: id, sha256: digest, byteSize: finalBytes.length, durationMs: actualDuration });
});

// The URL is a short-lived bearer URL, issued only after the caller has passed the parent post/story visibility check.
// The storage key is never exposed and media remains outside any static web root.
media.get("/media/:id", async (req, res) => {
  const id = /^\d{1,18}$/.test(req.params.id) ? req.params.id : null, viewer = String(req.query.u ?? "");
  if (!id || !/^GL-[A-Z]-[A-Z0-9-]{2,32}$/.test(viewer) || !isValidSignature(id, viewer, req.query.e, req.query.s)) return res.status(404).end();
  const user = await pool.query("SELECT id FROM users WHERE public_id=$1 AND deleted_at IS NULL", [viewer]);
  if (!user.rowCount) return res.status(404).end();
  const accessible = await pool.query(`SELECT 1 FROM media_assets a WHERE a.id=$1 AND a.status='ready' AND (
      EXISTS(SELECT 1 FROM post_attachments pa JOIN posts p ON p.id=pa.post_id WHERE pa.asset_id=a.id AND NOT p.hidden
        AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker=$2 AND b.blocked=p.user_id) OR (b.blocker=p.user_id AND b.blocked=$2))
        AND NOT EXISTS(SELECT 1 FROM mutes m WHERE m.muter=$2 AND m.muted=p.user_id))
      OR EXISTS(SELECT 1 FROM story_attachments sa JOIN stories s ON s.id=sa.story_id WHERE sa.asset_id=a.id AND NOT s.hidden AND s.expires_at>now()
        AND (s.user_id=$2 OR s.audience='everyone' OR (s.audience='followers' AND EXISTS(SELECT 1 FROM follows f WHERE f.follower=$2 AND f.followee=s.user_id))
          OR (s.audience='group' AND EXISTS(SELECT 1 FROM community_members cm WHERE cm.community_id=s.audience_group_id AND cm.user_id=$2)))
        AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker=$2 AND b.blocked=s.user_id) OR (b.blocker=s.user_id AND b.blocked=$2))
        AND NOT EXISTS(SELECT 1 FROM mutes m WHERE m.muter=$2 AND m.muted=s.user_id))
    )`, [id, user.rows[0].id]);
  if (!accessible.rowCount) return res.status(404).end();
  const asset = await pool.query("SELECT storage_key,content_type,byte_size FROM media_assets WHERE id=$1", [id]);
  if (!asset.rowCount) return res.status(404).end();
  res.setHeader("Content-Type", asset.rows[0].content_type);
  res.setHeader("Content-Length", String(asset.rows[0].byte_size));
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, max-age=60");
  const stream = createReadStream(path.join(storageDir(), asset.rows[0].storage_key));
  stream.on("error", () => { if (!res.headersSent) res.status(404).end(); else res.destroy(); });
  stream.pipe(res);
});

media.get("/admin/media-summary", adminOnly("ops"), async (_req,res)=>{
  const r=await pool.query(`SELECT 'all' status,COUNT(*)::int assets,COALESCE(SUM(byte_size),0)::bigint bytes,
      COUNT(*) FILTER (WHERE media_kind='image')::int images,COUNT(*) FILTER (WHERE media_kind='video')::int videos,
      (SELECT COUNT(*)::int FROM stories WHERE NOT hidden AND expires_at>now()) stories_live,
      (SELECT COUNT(*)::int FROM stories WHERE expires_at<=now() OR (hidden AND created_at<now()-interval '1 hour')) stories_expired
    FROM media_assets`);
  res.json(r.rows);
});

export async function cleanupMedia() {
  // Remove expired story rows after the expiry window; they are inaccessible immediately due to expires_at checks.
  await pool.query("DELETE FROM stories WHERE expires_at < now() - interval '1 hour' OR (hidden AND created_at < now() - interval '1 hour')");
  const orphaned = await pool.query(`DELETE FROM media_assets a WHERE
    (a.status='pending' AND a.created_at < now()-interval '30 minutes') OR
    (a.status='ready' AND a.created_at < now()-interval '1 hour' AND
      NOT EXISTS(SELECT 1 FROM post_attachments p WHERE p.asset_id=a.id) AND NOT EXISTS(SELECT 1 FROM story_attachments s WHERE s.asset_id=a.id))
    RETURNING storage_key`);
  for (const row of orphaned.rows) await unlink(path.join(storageDir(), row.storage_key)).catch(() => {});
}
export function startMediaCleanup() {
  const timer = setInterval(() => cleanupMedia().catch(e => console.error("media cleanup:", e.message)), 10 * 60_000);
  timer.unref();
}
