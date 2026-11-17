-- v0.32.0: verified activity dates and controlled volunteering XP.
-- Existing approved collection rows are intentionally not backfilled: their historical approval timestamp is unknown.
ALTER TABLE collections ADD COLUMN approved_at timestamptz;
CREATE INDEX collections_approved_activity ON collections(household_id,approved_at DESC)
  WHERE state='approved' AND accepted_grams>0 AND approved_at IS NOT NULL;
CREATE INDEX collections_approved_collector_activity ON collections(collector_id,approved_at DESC)
  WHERE state='approved' AND accepted_grams>0 AND approved_at IS NOT NULL;

ALTER TABLE xp_rules ADD COLUMN fixed_xp int CHECK (fixed_xp IS NULL OR fixed_xp BETWEEN 1 AND 10000);
ALTER TABLE xp_ledger ADD COLUMN source_kind text NOT NULL DEFAULT 'collection'
  CHECK (source_kind IN ('collection','campaign_attendance'));
ALTER TABLE xp_ledger ADD COLUMN source_id text;
CREATE UNIQUE INDEX xp_ledger_activity_source ON xp_ledger(source_kind,source_id,user_id)
  WHERE source_id IS NOT NULL;

-- The volunteering rule awards a fixed, capped amount only after independent verification.
-- It reuses the existing XP ledger, not GREEN, and does not alter environmental-weight rankings.
INSERT INTO xp_rules(code,version,audience,grams_per_xp,fixed_xp,daily_cap_xp,note)
VALUES ('volunteer_verified',1,'individual',1,10,30,'10 XP for independently verified campaign attendance; max 30 XP per day')
ON CONFLICT(code,version) DO NOTHING;

INSERT INTO xp_rules(code,version,audience,grams_per_xp,fixed_xp,daily_cap_xp,note)
VALUES ('volunteer_verified_collector',1,'collector',1,10,30,'10 XP for independently verified campaign attendance; max 30 XP per day')
ON CONFLICT(code,version) DO NOTHING;
