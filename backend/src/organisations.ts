import { Router } from "express";
import { z } from "zod";
import { pool, tx } from "./db.ts";
import { requireRole, rateLimit } from "./auth.ts";
import { adminOnly } from "./adminAuth.ts";
import { parseId } from "./pickupRules.ts";
import { awardXpForCampaignAttendance } from "./identity.ts";

export const organisations = Router();
const member = requireRole("individual", "collector");
const orgId = (v: string) => /^GL-O-\d{3,12}$/.test(v);
const audit = (q: { query: Function }, actor: string, action: string, detail: object) => q.query("INSERT INTO audit_log(actor,action,detail) VALUES($1,$2,$3)", [actor, action, detail]);

async function membership(uid: string, publicId: string) {
  return (await pool.query(`SELECT o.id,o.public_id,o.name,o.verification_status,m.member_role,m.membership_status
    FROM organisations o JOIN organisation_members m ON m.organisation_id=o.id
    WHERE o.public_id=$1 AND m.user_id=$2`, [publicId, uid])).rows[0] ?? null;
}
async function canManage(uid: string, publicId: string) {
  const m = await membership(uid, publicId);
  return m && m.verification_status === "verified" && m.membership_status === "active" && ["owner", "admin", "manager"].includes(m.member_role) ? m : null;
}

organisations.get("/explore/organisations", member, async (req, res) => {
  const type = ["ngo","school","college","university","society","business","csr","environmental_partner"].includes(String(req.query.type)) ? String(req.query.type) : null;
  const city = typeof req.query.city === "string" ? req.query.city.trim().slice(0,80) : null;
  const r = await pool.query(`SELECT o.public_id,o.name,o.organisation_type,o.description,o.city,o.state,
      (SELECT COUNT(*) FROM organisation_members m WHERE m.organisation_id=o.id AND m.membership_status='active')::int members,
      (SELECT COUNT(*) FROM campaigns c WHERE c.organisation_id=o.id AND c.status IN ('published','active') AND c.ends_at>now())::int active_campaigns
    FROM organisations o WHERE o.verification_status='verified' AND ($1::text IS NULL OR o.organisation_type=$1)
      AND ($2::text IS NULL OR lower(o.city)=lower($2)) ORDER BY active_campaigns DESC,o.name LIMIT 100`, [type,city]);
  res.json(r.rows);
});

organisations.get("/explore/campaigns", member, async (req,res)=>{
  const type=["recycling","plantation","cleanliness","awareness","education","volunteering","other"].includes(String(req.query.type))?String(req.query.type):null;
  const r=await pool.query(`SELECT c.public_id,c.title,c.description,c.campaign_type,c.location_text,c.starts_at,c.ends_at,c.target_grams,
      o.public_id organisation_id,o.name organisation,
      (SELECT COUNT(*) FROM campaign_members cm WHERE cm.campaign_id=c.id AND cm.status='joined')::int participants,
      (c.capacity IS NULL OR (SELECT COUNT(*) FROM campaign_members cm WHERE cm.campaign_id=c.id AND cm.status='joined')<c.capacity) accepting
    FROM campaigns c JOIN organisations o ON o.id=c.organisation_id
    WHERE o.verification_status='verified' AND c.status IN ('published','active') AND c.ends_at>now() AND ($1::text IS NULL OR c.campaign_type=$1)
    ORDER BY c.starts_at LIMIT 100`,[type]); res.json(r.rows);
});

organisations.post("/organisations", member, rateLimit(3,60_000), async(req,res)=>{
  const b=z.object({name:z.string().trim().min(3).max(100),type:z.enum(["ngo","school","college","university","society","business","csr","environmental_partner"]),description:z.string().trim().max(1200).default(""),website:z.string().url().max(200).optional(),email:z.string().email().max(150).optional(),phone:z.string().trim().max(30).optional(),city:z.string().trim().min(2).max(80),state:z.string().trim().min(2).max(80)}).safeParse(req.body);
  if(!b.success) return res.status(400).json({error:"invalid"});
  const out=await tx(async c=>{
    const o=(await c.query(`INSERT INTO organisations(public_id,name,organisation_type,description,website,email,phone,city,state,created_by)
      VALUES('GL-O-'||nextval('gl_org_seq'),$1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING public_id,name,verification_status`,[b.data.name,b.data.type,b.data.description,b.data.website??null,b.data.email??null,b.data.phone??null,b.data.city,b.data.state,req.auth!.sub])).rows[0];
    await c.query("INSERT INTO organisation_members(organisation_id,user_id,member_role,membership_status,joined_at) SELECT id,$2,'owner','active',now() FROM organisations WHERE public_id=$1",[o.public_id,req.auth!.sub]);
    await audit(c,req.auth!.sub,"organisation.apply",{publicId:o.public_id,type:b.data.type}); return o;
  }); res.status(201).json(out);
});

organisations.get("/me/organisations", member, async(req,res)=>{
  const r=await pool.query(`SELECT o.public_id,o.name,o.organisation_type,o.verification_status,m.member_role,m.membership_status,m.joined_at
    FROM organisation_members m JOIN organisations o ON o.id=m.organisation_id WHERE m.user_id=$1 ORDER BY m.created_at DESC LIMIT 100`,[req.auth!.sub]); res.json(r.rows);
});

organisations.get("/organisations/:pid", member, async(req,res)=>{
  if(!orgId(req.params.pid)) return res.status(404).json({error:"not_found"});
  const r=await pool.query(`SELECT o.public_id,o.name,o.organisation_type,o.description,o.website,o.city,o.state,o.verification_status,
      (SELECT COUNT(*) FROM organisation_members m WHERE m.organisation_id=o.id AND m.membership_status='active')::int members,
      EXISTS(SELECT 1 FROM organisation_members m WHERE m.organisation_id=o.id AND m.user_id=$2 AND m.membership_status='active') member
    FROM organisations o WHERE o.public_id=$1 AND o.verification_status='verified'`,[req.params.pid,req.auth!.sub]);
  r.rowCount?res.json(r.rows[0]):res.status(404).json({error:"not_found"});
});

organisations.post("/organisations/:pid/join", member, rateLimit(10,60_000), async(req,res)=>{
  if(!orgId(req.params.pid)) return res.status(404).json({error:"not_found"});
  const o=(await pool.query("SELECT id,join_policy FROM organisations WHERE public_id=$1 AND verification_status='verified'",[req.params.pid])).rows[0];
  if(!o) return res.status(404).json({error:"not_found"}); if(o.join_policy!="request") return res.status(409).json({error:"joining_closed"});
  const joined = await pool.query(`INSERT INTO organisation_members(organisation_id,user_id,member_role,membership_status)
    VALUES($1,$2,'member','pending') ON CONFLICT(organisation_id,user_id) DO UPDATE SET membership_status='pending'
    WHERE organisation_members.membership_status IN ('rejected','removed') RETURNING membership_status`,[o.id,req.auth!.sub]);
  const current = joined.rows[0]?.membership_status ?? (await pool.query("SELECT membership_status FROM organisation_members WHERE organisation_id=$1 AND user_id=$2",[o.id,req.auth!.sub])).rows[0]?.membership_status;
  res.json({ok:true,status:current ?? "pending"});
});

organisations.get("/organisations/:pid/campaigns", member, async(req,res)=>{
  if(!orgId(req.params.pid)) return res.status(404).json({error:"not_found"});
  const r=await pool.query(`SELECT c.public_id,c.title,c.description,c.campaign_type,c.location_text,c.starts_at,c.ends_at,c.target_grams,c.capacity,c.status,
      (SELECT COUNT(*) FROM campaign_members m WHERE m.campaign_id=c.id AND m.status='joined')::int participants,
      EXISTS(SELECT 1 FROM campaign_members m WHERE m.campaign_id=c.id AND m.user_id=$2 AND m.status='joined') joined
    FROM campaigns c JOIN organisations o ON o.id=c.organisation_id
    WHERE o.public_id=$1 AND o.verification_status='verified' AND c.status IN ('published','active','completed') ORDER BY c.starts_at DESC LIMIT 100`,[req.params.pid,req.auth!.sub]); res.json(r.rows);
});

organisations.get("/organisations/:pid/members", member, async(req,res)=>{
  if(!orgId(req.params.pid)) return res.status(404).json({error:"not_found"});
  const m=await canManage(req.auth!.sub,req.params.pid); if(!m) return res.status(404).json({error:"not_found"});
  const r=await pool.query(`SELECT u.public_id,COALESCE(u.display_name,u.public_id) name,om.member_role,om.membership_status,om.created_at,om.joined_at
    FROM organisation_members om JOIN users u ON u.id=om.user_id WHERE om.organisation_id=$1 ORDER BY CASE om.membership_status WHEN 'pending' THEN 0 ELSE 1 END,om.created_at DESC LIMIT 300`,[m.id]);
  res.json(r.rows);
});
organisations.post("/organisations/:pid/members/:userPid/status", member, async(req,res)=>{
  if(!orgId(req.params.pid)||!/^GL-[A-Z]-[A-Z0-9-]{2,32}$/.test(req.params.userPid)) return res.status(404).json({error:"not_found"});
  const m=await canManage(req.auth!.sub,req.params.pid); if(!m) return res.status(404).json({error:"not_found"});
  const b=z.object({status:z.enum(["active","rejected","removed"]),note:z.string().trim().min(5).max(300)}).safeParse(req.body); if(!b.success) return res.status(400).json({error:"invalid"});
  const r=await pool.query(`UPDATE organisation_members om SET membership_status=$1,joined_at=CASE WHEN $1='active' THEN COALESCE(joined_at,now()) ELSE joined_at END
    FROM users u WHERE om.organisation_id=$2 AND om.user_id=u.id AND u.public_id=$3 AND om.member_role<>'owner' RETURNING u.public_id,om.membership_status`,[b.data.status,m.id,req.params.userPid]);
  if(!r.rowCount) return res.status(404).json({error:"not_found"});
  await audit(pool,req.auth!.sub,"organisation.member.status",{organisation:req.params.pid,user:req.params.userPid,status:b.data.status,note:b.data.note}); res.json(r.rows[0]);
});

organisations.get("/organisations/:pid/attendance", member, async(req,res)=>{
  if(!orgId(req.params.pid)) return res.status(404).json({error:"not_found"});
  const m=await canManage(req.auth!.sub,req.params.pid); if(!m) return res.status(404).json({error:"not_found"});
  const status=["pending","verified","rejected"].includes(String(req.query.status))?String(req.query.status):null;
  const r=await pool.query(`SELECT a.id::text,a.activity_date,a.hours,a.note,a.status,a.verification_note,a.verified_at,
      u.public_id user_public_id,COALESCE(u.display_name,u.public_id) user_name,
      c.public_id campaign_public_id,c.title campaign_title,
      COALESCE(rec.display_name,rec.public_id) recorded_by,
      COALESCE(ver.display_name,ver.public_id) verified_by
    FROM campaign_attendance a JOIN campaigns c ON c.id=a.campaign_id JOIN users u ON u.id=a.user_id
      JOIN users rec ON rec.id=a.recorded_by LEFT JOIN users ver ON ver.id=a.verified_by
    WHERE c.organisation_id=$1 AND ($2::text IS NULL OR a.status=$2)
    ORDER BY CASE a.status WHEN 'pending' THEN 0 ELSE 1 END,a.activity_date DESC,a.created_at DESC LIMIT 300`,[m.id,status]);
  res.json(r.rows);
});

organisations.get("/organisations/:pid/dashboard", member, async(req,res)=>{
  if(!orgId(req.params.pid)) return res.status(404).json({error:"not_found"}); const m=await canManage(req.auth!.sub,req.params.pid); if(!m) return res.status(404).json({error:"not_found"});
  const [members,campaigns,attendance]=await Promise.all([
    pool.query("SELECT membership_status,COUNT(*)::int count FROM organisation_members WHERE organisation_id=$1 GROUP BY membership_status",[m.id]),
    pool.query("SELECT status,COUNT(*)::int count FROM campaigns WHERE organisation_id=$1 GROUP BY status",[m.id]),
    pool.query(`SELECT COUNT(*)::int entries,COALESCE(SUM(hours),0)::numeric(10,2) verified_hours FROM campaign_attendance a JOIN campaigns c ON c.id=a.campaign_id WHERE c.organisation_id=$1 AND a.status='verified'`,[m.id])]);
  res.json({organisation:{publicId:m.public_id,name:m.name},members:members.rows,campaigns:campaigns.rows,attendance:attendance.rows[0]});
});

organisations.post("/organisations/:pid/campaigns", member, rateLimit(10,60_000), async(req,res)=>{
  if(!orgId(req.params.pid)) return res.status(404).json({error:"not_found"}); const m=await canManage(req.auth!.sub,req.params.pid); if(!m) return res.status(404).json({error:"not_found"});
  const b=z.object({title:z.string().trim().min(3).max(120),description:z.string().trim().min(10).max(2000),type:z.enum(["recycling","plantation","cleanliness","awareness","education","volunteering","other"]),location:z.string().trim().min(2).max(160),startsAt:z.string().datetime(),endsAt:z.string().datetime(),targetGrams:z.number().int().positive().optional(),capacity:z.number().int().min(1).max(100000).optional()}).safeParse(req.body);
  if(!b.success||new Date(b.data.endsAt)<=new Date(b.data.startsAt)) return res.status(400).json({error:"invalid"});
  const out=await pool.query(`INSERT INTO campaigns(public_id,organisation_id,title,description,campaign_type,location_text,starts_at,ends_at,target_grams,capacity,created_by)
    VALUES('GL-CMP-'||nextval('gl_org_seq'),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING public_id,title,status`,[m.id,b.data.title,b.data.description,b.data.type,b.data.location,b.data.startsAt,b.data.endsAt,b.data.targetGrams??null,b.data.capacity??null,req.auth!.sub]);
  await audit(pool,req.auth!.sub,"campaign.create",{publicId:out.rows[0].public_id,organisation:req.params.pid}); res.status(201).json(out.rows[0]);
});

organisations.post("/campaigns/:pid/publish", member, async(req,res)=>{
  const cpid=req.params.pid; const c=await pool.query(`SELECT c.id,c.organisation_id,o.public_id FROM campaigns c JOIN organisations o ON o.id=c.organisation_id WHERE c.public_id=$1 AND c.status='draft'`,[cpid]);
  if(!c.rowCount) return res.status(404).json({error:"not_found"}); if(!(await canManage(req.auth!.sub,c.rows[0].public_id))) return res.status(404).json({error:"not_found"});
  await pool.query("UPDATE campaigns SET status=CASE WHEN starts_at<=now() THEN 'active' ELSE 'published' END,updated_at=now() WHERE id=$1",[c.rows[0].id]); await audit(pool,req.auth!.sub,"campaign.publish",{publicId:cpid}); res.json({ok:true});
});

organisations.post("/campaigns/:pid/join", member, async(req,res)=>{
  const c=await pool.query(`SELECT c.id,c.capacity,c.starts_at,c.ends_at,c.status,(SELECT COUNT(*) FROM campaign_members cm WHERE cm.campaign_id=c.id AND cm.status='joined')::int participants
    FROM campaigns c JOIN organisations o ON o.id=c.organisation_id WHERE c.public_id=$1 AND o.verification_status='verified'`,[req.params.pid]);
  if(!c.rowCount) return res.status(404).json({error:"not_found"}); const x=c.rows[0];
  if(!["published","active"].includes(x.status)||new Date(x.ends_at)<=new Date()) return res.status(409).json({error:"campaign_not_open"});
  try { const out=await tx(async q=>{
    const locked=await q.query("SELECT id,capacity FROM campaigns WHERE id=$1 AND status IN ('published','active') FOR UPDATE",[x.id]); if(!locked.rowCount) throw new Error("campaign_not_open");
    const n=Number((await q.query("SELECT COUNT(*)::int n FROM campaign_members WHERE campaign_id=$1 AND status='joined'",[x.id])).rows[0].n);
    if(locked.rows[0].capacity && n>=locked.rows[0].capacity) throw new Error("campaign_full");
    await q.query("INSERT INTO campaign_members(campaign_id,user_id) VALUES($1,$2) ON CONFLICT(campaign_id,user_id) DO UPDATE SET status='joined',joined_at=now()",[x.id,req.auth!.sub]); return {ok:true};
  }); res.json(out); } catch(e:any){ if(["campaign_not_open","campaign_full"].includes(e.message)) return res.status(409).json({error:e.message}); throw e; }
});

organisations.post("/campaigns/:pid/attendance", member, async(req,res)=>{
  const b=z.object({userPublicId:z.string().regex(/^GL-[A-Z]-[A-Z0-9-]{2,32}$/),date:z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/),hours:z.number().min(0.25).max(16),note:z.string().trim().min(5).max(500)}).safeParse(req.body); if(!b.success) return res.status(400).json({error:"invalid"});
  const c=await pool.query("SELECT id,organisation_id FROM campaigns WHERE public_id=$1",[req.params.pid]); if(!c.rowCount) return res.status(404).json({error:"not_found"});
  const org=(await pool.query("SELECT public_id FROM organisations WHERE id=$1",[c.rows[0].organisation_id])).rows[0]; if(!(await canManage(req.auth!.sub,org.public_id))) return res.status(404).json({error:"not_found"});
  const out=await pool.query(`INSERT INTO campaign_attendance(campaign_id,user_id,activity_date,hours,note,recorded_by)
    SELECT $1,u.id,$2,$3,$4,$5 FROM users u JOIN campaign_members cm ON cm.user_id=u.id AND cm.campaign_id=$1 AND cm.status='joined'
    WHERE u.public_id=$6 AND u.deleted_at IS NULL ON CONFLICT(campaign_id,user_id,activity_date) DO NOTHING RETURNING id::text,status`,[c.rows[0].id,b.data.date,b.data.hours,b.data.note,req.auth!.sub,b.data.userPublicId]);
  if(!out.rowCount) return res.status(409).json({error:"member_not_joined_or_record_exists"}); res.status(201).json(out.rows[0]);
});

organisations.post("/campaigns/:pid/attendance/:id/verify", member, async(req,res)=>{
  const b=z.object({status:z.enum(["verified","rejected"]),note:z.string().trim().min(5).max(500)}).safeParse(req.body), id=parseId(req.params.id); if(!id||!b.success) return res.status(400).json({error:"invalid"});
  const row=await pool.query(`SELECT a.id,a.recorded_by,o.public_id FROM campaign_attendance a JOIN campaigns c ON c.id=a.campaign_id JOIN organisations o ON o.id=c.organisation_id
    WHERE a.id=$1 AND c.public_id=$2 AND a.status='pending'`,[id,req.params.pid]); if(!row.rowCount) return res.status(404).json({error:"not_found"});
  if(row.rows[0].recorded_by===req.auth!.sub) return res.status(409).json({error:"two_person_verification_required"});
  if(!(await canManage(req.auth!.sub,row.rows[0].public_id))) return res.status(404).json({error:"not_found"});
  try {
    await tx(async c=>{
      const locked=await c.query("SELECT id,user_id,recorded_by,status FROM campaign_attendance WHERE id=$1 FOR UPDATE",[id]);
      if(!locked.rowCount || locked.rows[0].status!=="pending") throw new Error("attendance_already_reviewed");
      if(locked.rows[0].recorded_by===req.auth!.sub || locked.rows[0].user_id===req.auth!.sub) throw new Error("two_person_verification_required");
      await c.query("UPDATE campaign_attendance SET status=$1,verified_by=$2,verification_note=$3,verified_at=CASE WHEN $1='verified' THEN now() ELSE NULL END WHERE id=$4",[b.data.status,req.auth!.sub,b.data.note,id]);
      if(b.data.status==="verified") await awardXpForCampaignAttendance(c,id,locked.rows[0].user_id);
      await audit(c,req.auth!.sub,"campaign.attendance.verify",{attendanceId:id,status:b.data.status});
    });
  } catch(e:any) { if(e.message==="attendance_already_reviewed" || e.message==="two_person_verification_required") return res.status(409).json({error:e.message}); throw e; }
  res.json({ok:true});
});

organisations.post("/campaigns/:pid/sponsorships", member, async(req,res)=>{
  const b=z.object({sponsorName:z.string().trim().min(2).max(100),amountMinor:z.number().int().min(0).max(100000000000).optional(),note:z.string().max(300).optional()}).safeParse(req.body); if(!b.success) return res.status(400).json({error:"invalid"});
  const c=await pool.query("SELECT id,organisation_id FROM campaigns WHERE public_id=$1",[req.params.pid]); if(!c.rowCount) return res.status(404).json({error:"not_found"});
  const org=(await pool.query("SELECT public_id FROM organisations WHERE id=$1",[c.rows[0].organisation_id])).rows[0]; if(!(await canManage(req.auth!.sub,org.public_id))) return res.status(404).json({error:"not_found"});
  const r=await pool.query("INSERT INTO campaign_sponsorships(campaign_id,sponsor_name,pledged_amount_minor,reference_note,recorded_by) VALUES($1,$2,$3,$4,$5) RETURNING id::text,status",[c.rows[0].id,b.data.sponsorName,b.data.amountMinor??null,b.data.note??null,req.auth!.sub]);
  await audit(pool,req.auth!.sub,"campaign.sponsorship.declared",{campaign:req.params.pid,sponsorshipId:r.rows[0].id}); res.status(201).json(r.rows[0]);
});

// Organisation events are public only after the organisation itself is verified. RSVP still uses the existing event service.
organisations.post("/organisations/:pid/events", member, rateLimit(8,60_000), async(req,res)=>{
  if(!orgId(req.params.pid)) return res.status(404).json({error:"not_found"});
  const m=await canManage(req.auth!.sub,req.params.pid); if(!m) return res.status(404).json({error:"not_found"});
  const b=z.object({title:z.string().trim().min(3).max(120),description:z.string().trim().max(500).optional(),location:z.string().trim().max(120).optional(),startsAt:z.string().datetime()}).safeParse(req.body);
  if(!b.success || new Date(b.data.startsAt)<=new Date()) return res.status(400).json({error:"invalid"});
  const r=await pool.query(`INSERT INTO events(organisation_id,title,description,location_text,starts_at,created_by)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING id::text,title,starts_at`,[m.id,b.data.title,b.data.description??null,b.data.location??null,b.data.startsAt,req.auth!.sub]);
  await audit(pool,req.auth!.sub,"organisation.event.create",{organisation:req.params.pid,eventId:r.rows[0].id});
  res.status(201).json(r.rows[0]);
});

// Organisation verification is an operations action; verification never grants financial permissions.
organisations.get("/admin/organisations", adminOnly("ops"), async(_req,res)=>{
  const r=await pool.query(`SELECT o.public_id,o.name,o.organisation_type,o.city,o.state,o.verification_status,o.created_at,
      COALESCE(u.display_name,u.public_id) applicant,(SELECT COUNT(*) FROM organisation_members m WHERE m.organisation_id=o.id AND m.membership_status='active')::int members
    FROM organisations o JOIN users u ON u.id=o.created_by ORDER BY CASE o.verification_status WHEN 'pending' THEN 0 ELSE 1 END,o.created_at DESC LIMIT 300`); res.json(r.rows);
});
organisations.post("/admin/organisations/:pid/verification", adminOnly("ops"), async(req,res)=>{
  const b=z.object({status:z.enum(["verified","rejected","suspended"]),note:z.string().trim().min(5).max(500)}).safeParse(req.body); if(!b.success||!orgId(req.params.pid)) return res.status(400).json({error:"invalid"});
  const r=await pool.query(`UPDATE organisations SET verification_status=$1,verified_by=$2,verification_note=$3,verified_at=CASE WHEN $1='verified' THEN now() ELSE verified_at END,updated_at=now()
    WHERE public_id=$4 RETURNING public_id,name,verification_status`,[b.data.status,req.auth!.sub,b.data.note,req.params.pid]);
  if(!r.rowCount) return res.status(404).json({error:"not_found"}); await audit(pool,req.auth!.sub,"organisation.verification",{publicId:req.params.pid,status:b.data.status,note:b.data.note}); res.json(r.rows[0]);
});
