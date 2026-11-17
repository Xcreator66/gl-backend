-- v0.30.0: GREEN IDENTITY. XP, levels, ranks and titles are reputation only. Nothing here touches ledger_entries, and no code reading
-- these tables may post GREEN (a test enforces this). XP comes only from independently verified recycling.
CREATE TABLE xp_rules (
  code text NOT NULL CHECK (code ~ '^[a-z0-9_]{3,40}$'), version int NOT NULL CHECK (version >= 1), audience text NOT NULL CHECK (audience IN ('individual','collector')),
  grams_per_xp int NOT NULL CHECK (grams_per_xp > 0), daily_cap_xp int NOT NULL CHECK (daily_cap_xp > 0), active boolean NOT NULL DEFAULT true,
  note text, created_by uuid REFERENCES users, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (code, version));
CREATE UNIQUE INDEX xp_rules_one_active ON xp_rules(code) WHERE active;
INSERT INTO xp_rules(code,version,audience,grams_per_xp,daily_cap_xp,note) VALUES
  ('recycling_verified',1,'individual',100,300,'1 XP per 100 g of verified weight; at most 300 XP per day'),
  ('recycling_handled',1,'collector',200,400,'1 XP per 200 g handled and verified; at most 400 XP per day');
-- Append-only. A reversal is a negative row pointing at the row it reverses.
CREATE TABLE xp_ledger (
  id bigserial PRIMARY KEY, user_id uuid NOT NULL REFERENCES users, audience text NOT NULL CHECK (audience IN ('individual','collector')),
  rule_code text NOT NULL, rule_version int NOT NULL, xp int NOT NULL CHECK (xp <> 0), collection_id uuid REFERENCES collections,
  reverses_id bigint REFERENCES xp_ledger, idempotency_key text UNIQUE NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (rule_code, rule_version) REFERENCES xp_rules(code, version));
CREATE INDEX xp_ledger_user ON xp_ledger(user_id, created_at); CREATE INDEX xp_ledger_board ON xp_ledger(audience, created_at);
CREATE TRIGGER xp_ledger_immutable BEFORE UPDATE OR DELETE ON xp_ledger FOR EACH ROW EXECUTE FUNCTION fin_record_immutable();
CREATE TABLE identity_levels (level int PRIMARY KEY CHECK (level >= 1), xp_required int NOT NULL CHECK (xp_required >= 0));
INSERT INTO identity_levels(level,xp_required) SELECT n, 50*(n-1)*(n-1) FROM generate_series(1,50) n;
CREATE TABLE identity_ranks (code text PRIMARY KEY CHECK (code ~ '^[a-z_]{3,30}$'), name text NOT NULL, position int UNIQUE NOT NULL, min_score int NOT NULL CHECK (min_score BETWEEN 0 AND 100));
INSERT INTO identity_ranks(code,name,position,min_score) VALUES ('newcomer','Newcomer',1,0),('contributor','Contributor',2,15),('guardian','Guardian',3,30),
  ('champion','Champion',4,45),('eco_leader','Eco Leader',5,60),('earth_legend','Earth Legend',6,85);
CREATE TABLE identity_titles (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9_]{3,40}$'), name text NOT NULL, description text NOT NULL, eligible_roles text[] NOT NULL,
  award_mode text NOT NULL CHECK (award_mode IN ('automatic','admin_verified')), criteria jsonb NOT NULL DEFAULT '{}', verification text NOT NULL, active boolean NOT NULL DEFAULT true);
INSERT INTO identity_titles(id,name,description,eligible_roles,award_mode,criteria,verification) VALUES
 ('plastic_warrior','Plastic Warrior','25 kg of plastic (PET and other plastics) verified by a recycler.','{individual,collector}','automatic','{"materials":["PET","PLS"],"min_grams":25000}','Recycler-verified weight, approved collections only'),
 ('recycling_champion','Recycling Champion','250 kg of recycling verified by a recycler.','{individual}','automatic','{"min_grams":250000}','Recycler-verified weight, approved collections only'),
 ('lifetime_contributor','Lifetime Contributor','1 tonne of recycling verified by a recycler.','{individual,collector}','automatic','{"min_grams":1000000}','Recycler-verified weight, approved collections only'),
 ('zero_waste_hero','Zero Waste Hero','Sustained verified low-waste practice.','{individual}','admin_verified','{}','Administrator reviews evidence and records a note'),
 ('community_builder','Community Builder','Built and sustained a local sustainability community.','{individual}','admin_verified','{}','Administrator reviews evidence and records a note'),
 ('green_volunteer','Green Volunteer','Verified volunteering at sustainability events.','{individual}','admin_verified','{}','Needs verified attendance (institutional module, not yet built); admin-verified until then'),
 ('tree_guardian','Tree Guardian','Verified tree planting and care.','{individual}','admin_verified','{}','Administrator reviews evidence and records a note'),
 ('campaign_leader','Campaign Leader','Led a successful verified campaign.','{individual}','admin_verified','{}','Administrator reviews evidence and records a note'),
 ('founding_member','Founding Member','Joined during the pilot.','{individual,collector,recycler}','admin_verified','{}','Administrator grants from the pilot roster'),
 ('environmental_educator','Environmental Educator','Verified educational contribution.','{individual}','admin_verified','{}','Administrator reviews evidence and records a note'),
 ('sustainability_innovator','Sustainability Innovator','Verified innovation in sustainability practice.','{individual}','admin_verified','{}','Administrator reviews evidence and records a note');
CREATE TABLE user_titles (
  user_id uuid NOT NULL REFERENCES users, title_id text NOT NULL REFERENCES identity_titles, awarded_at timestamptz NOT NULL DEFAULT now(),
  awarded_by uuid REFERENCES users, evidence_note text, displayed boolean NOT NULL DEFAULT false, revoked_at timestamptz, revoke_reason text, PRIMARY KEY (user_id, title_id));
ALTER TABLE users ADD COLUMN IF NOT EXISTS leaderboard_opt_out boolean NOT NULL DEFAULT false;
-- Existing earned badges are NOT touched: user_badges stays the source of truth and is read as-is by the identity profile (no migration of rows, so no duplicates).
-- Rollback (only while empty): DROP TABLE user_titles, identity_titles, identity_ranks, identity_levels, xp_ledger, xp_rules; ALTER TABLE users DROP COLUMN leaderboard_opt_out;
