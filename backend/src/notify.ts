import { Router } from "express";
import { z } from "zod";
import type pg from "pg";
import { pool } from "./db.ts";
import { requireRole } from "./auth.ts";

/** In-app notification. Pass the transaction client so it commits/rolls back with the business change. */
export const notify = (q: pg.Pool | pg.PoolClient, userId: string, kind: string, title: string, body: string) =>
  q.query("INSERT INTO notifications(user_id,kind,title,body) VALUES($1,$2,$3,$4)", [userId, kind, title, body]);

/** Sends push for committed notifications only (polls the table), at-most-once, best effort. */
export function startPushWorker() {
  setInterval(async () => {
    try {
      const r = await pool.query("UPDATE notifications SET pushed_at=now() WHERE pushed_at IS NULL RETURNING user_id,title,body");
      if (!r.rowCount) return;
      const t = await pool.query("SELECT user_id,token FROM push_tokens WHERE user_id=ANY($1)", [[...new Set(r.rows.map(x => x.user_id))]]);
      const msgs = r.rows.flatMap(n => t.rows.filter(k => k.user_id === n.user_id).map(k => ({ to: k.token, title: n.title, body: n.body })));
      for (let i = 0; i < msgs.length; i += 100)
        await fetch("https://exp.host/--/api/v2/push/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(msgs.slice(i, i + 100)) });
    } catch (e) { console.error("push worker:", e); }
  }, 15_000);
}

export const notifications = Router();
const anyRole = requireRole("individual", "collector", "recycler", "admin");
notifications.get("/me/notifications", anyRole, async (req, res) => {
  const r = await pool.query("SELECT id::text,kind,title,body,read_at,created_at FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 30", [req.auth!.sub]);
  res.json({ unread: r.rows.filter(x => !x.read_at).length, items: r.rows });
});
notifications.post("/me/notifications/read", anyRole, async (req, res) => {
  await pool.query("UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL", [req.auth!.sub]); res.json({ ok: true });
});
notifications.post("/me/push-token", anyRole, async (req, res) => {
  const b = z.object({ token: z.string().regex(/^Expo(nent)?PushToken\[.+\]$/), platform: z.string().max(10).optional() }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: "invalid" });
  await pool.query("INSERT INTO push_tokens(token,user_id,platform) VALUES($1,$2,$3) ON CONFLICT(token) DO UPDATE SET user_id=EXCLUDED.user_id", [b.data.token, req.auth!.sub, b.data.platform ?? null]);
  res.json({ ok: true });
});
