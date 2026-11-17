-- v0.21.0: achievement badges (derived from verified weight only) and referral invites (identification only, never rewards).
-- user_badges records WHEN a badge was first seen as earned and whether it was shared. Whether a badge is shown as earned is always
-- recomputed from current approved weight, so an adjusted or reversed collection removes the badge it supported.
-- Nothing in this migration touches ledger_entries, and no code path that reads these tables may post GREEN.
CREATE TABLE user_badges (
  user_id uuid NOT NULL REFERENCES users, badge_id text NOT NULL CHECK (badge_id ~ '^[a-z0-9_]{3,40}$'),
  earned_at timestamptz NOT NULL DEFAULT now(), shared_at timestamptz, PRIMARY KEY (user_id, badge_id));
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code text UNIQUE CHECK (referral_code ~ '^[0-9A-HJKMNP-TV-Z]{8}$');
-- referrals(referrer, referred UNIQUE, created_at) already exists from 002: a person can be invited once. Make self-referral impossible in the database too.
ALTER TABLE referrals ADD CONSTRAINT referral_not_self CHECK (referrer <> referred);
CREATE INDEX IF NOT EXISTS referrals_referrer ON referrals(referrer);
