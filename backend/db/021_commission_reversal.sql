-- v0.30.0: automatic proportional commission reversal, partial reward reversal, recoverable commission balances.
-- Additive only. No ledger rows are changed or deleted. Historic adjusted collections are NOT silently re-reversed (see v_unreversed_commission_review).
CREATE FUNCTION fin_record_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$ LANGUAGE plpgsql;

ALTER TABLE collections ADD COLUMN reward_reversed_green bigint NOT NULL DEFAULT 0 CHECK (reward_reversed_green >= 0);
UPDATE collections SET reward_reversed_green = COALESCE(green_awarded,0) WHERE state = 'adjusted';
ALTER TABLE collections ADD CONSTRAINT reward_reversed_le_awarded CHECK (reward_reversed_green <= COALESCE(green_awarded,0));

ALTER TABLE commissions ADD COLUMN reversed_green bigint NOT NULL DEFAULT 0 CHECK (reversed_green >= 0);
ALTER TABLE commissions ADD CONSTRAINT commission_reversed_le_green CHECK (reversed_green <= green);
UPDATE commissions SET reversed_green = green WHERE state = 'reversed';

-- One row per reward reversal event (full or partial). The idempotency key makes a retried request a no-op.
CREATE TABLE reward_reversals (
  id bigserial PRIMARY KEY, idempotency_key text UNIQUE NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 120),
  collection_id uuid NOT NULL REFERENCES collections, amount_green bigint NOT NULL CHECK (amount_green >= 0),
  reward_txn uuid, via text NOT NULL, reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 300),
  actor uuid NOT NULL REFERENCES users, created_at timestamptz NOT NULL DEFAULT now());
-- One row per commission effect of a reward reversal. reverse_green left the collector's balance (ledger txn recorded);
-- recoverable_green could not be taken (already spent/paid) and is tracked in commission_recoverables; waived_green was
-- deliberately NOT reversed by a super-admin override (reason + permission required, see commissionReversal.ts).
CREATE TABLE commission_reversals (
  id bigserial PRIMARY KEY, commission_id bigint NOT NULL REFERENCES commissions, collection_id uuid NOT NULL REFERENCES collections,
  reward_reversal_id bigint NOT NULL REFERENCES reward_reversals UNIQUE,
  kind text NOT NULL CHECK (kind IN ('automatic','override_waived')),
  reverse_green bigint NOT NULL DEFAULT 0 CHECK (reverse_green >= 0), recoverable_green bigint NOT NULL DEFAULT 0 CHECK (recoverable_green >= 0),
  waived_green bigint NOT NULL DEFAULT 0 CHECK (waived_green >= 0), commission_txn uuid,
  reason text NOT NULL, actor uuid NOT NULL REFERENCES users, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'automatic' OR (reverse_green = 0 AND recoverable_green = 0 AND waived_green > 0)),
  CHECK (kind = 'override_waived' OR waived_green = 0));
CREATE INDEX commission_reversals_commission ON commission_reversals(commission_id);
CREATE TRIGGER reward_reversals_immutable BEFORE UPDATE OR DELETE ON reward_reversals FOR EACH ROW EXECUTE FUNCTION fin_record_immutable();
CREATE TRIGGER commission_reversals_immutable BEFORE UPDATE OR DELETE ON commission_reversals FOR EACH ROW EXECUTE FUNCTION fin_record_immutable();

-- Money the collector no longer owns but had already spent. Never collected externally; settled only by a future approved accounting workflow.
CREATE TABLE commission_recoverables (
  id bigserial PRIMARY KEY, commission_id bigint NOT NULL REFERENCES commissions, collector_id uuid NOT NULL REFERENCES users,
  reversal_id bigint NOT NULL REFERENCES commission_reversals UNIQUE, green bigint NOT NULL CHECK (green > 0),
  settled_green bigint NOT NULL DEFAULT 0 CHECK (settled_green >= 0), state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','settled','written_off')),
  created_at timestamptz NOT NULL DEFAULT now(), CHECK (settled_green <= green));
CREATE INDEX commission_recoverables_collector ON commission_recoverables(collector_id) WHERE state = 'open';

-- Adjusted collections that predate this version still have their full commission. Finance reviews these; nothing is changed automatically.
CREATE VIEW v_unreversed_commission_review AS
  SELECT c.public_id AS collection, b.public_id AS batch, k.id AS commission_id, k.green AS commission_green, k.reversed_green
  FROM collections c JOIN batches b ON b.id = c.batch_id JOIN commissions k ON k.batch_id = b.id
  WHERE c.state = 'adjusted' AND k.reversed_green = 0 AND NOT EXISTS (SELECT 1 FROM reward_reversals r WHERE r.collection_id = c.id);
-- Rollback (only if no reversal has been recorded): DROP VIEW v_unreversed_commission_review; DROP TABLE commission_recoverables, commission_reversals, reward_reversals;
--   ALTER TABLE commissions DROP COLUMN reversed_green; ALTER TABLE collections DROP COLUMN reward_reversed_green; DROP FUNCTION fin_record_immutable();
