-- v0.14: admin role tiers. super = everything; finance = rewards, commissions, payouts, ledger, rates;
-- ops = batches, pickups, users (read), analytics, exports; moderator = reports, posts, challenges.
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_tier text CHECK (admin_tier IN ('super','finance','ops','moderator'));
UPDATE users SET admin_tier='super' WHERE role='admin' AND admin_tier IS NULL; -- existing admins keep full access
-- An admin must always have a tier and nobody else may have one. Granting admin by SQL now needs both:
--   UPDATE users SET role='admin', admin_tier='super' WHERE phone='+91...';
ALTER TABLE users ADD CONSTRAINT admin_tier_matches_role CHECK ((role='admin') = (admin_tier IS NOT NULL));
