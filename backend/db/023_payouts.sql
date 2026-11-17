-- v0.30.0: two-person payout approval. A payout is one attempt to pay one redemption. The redemption's GREEN is already in
-- user:<id>:locked (existing ledger hold); a payout RESERVES that hold: at most one active payout per redemption, and the sum of
-- active reservations may never exceed the locked balance. Real-money execution stays behind PAYOUT_EXECUTION_ENABLED (default off).
CREATE SEQUENCE gl_po_seq START 100001;
CREATE TABLE payouts (
  id bigserial PRIMARY KEY, public_id text UNIQUE NOT NULL, redemption_id bigint NOT NULL REFERENCES redemptions, user_id uuid NOT NULL REFERENCES users,
  attempt int NOT NULL CHECK (attempt >= 1), reserved_green bigint NOT NULL CHECK (reserved_green > 0), amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','processing','paid','failed','cancelled','rejected')),
  prepared_by uuid NOT NULL REFERENCES users, submitted_at timestamptz,
  approved_by uuid REFERENCES users, approved_at timestamptz, rejected_by uuid REFERENCES users, reject_reason text,
  executed_by uuid REFERENCES users, processing_at timestamptz, payment_ref text, paid_at timestamptz, failure_reason text,
  cancelled_by uuid REFERENCES users, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (redemption_id, attempt),
  CONSTRAINT payout_no_self_approval CHECK (approved_by IS NULL OR approved_by <> prepared_by),
  CONSTRAINT payout_no_self_reject CHECK (rejected_by IS NULL OR rejected_by <> prepared_by),
  CONSTRAINT payout_reject_needs_reason CHECK (status <> 'rejected' OR char_length(COALESCE(reject_reason,'')) >= 3),
  CONSTRAINT payout_paid_needs_ref CHECK (status <> 'paid' OR (payment_ref IS NOT NULL AND approved_by IS NOT NULL AND paid_at IS NOT NULL)));
CREATE UNIQUE INDEX payouts_one_active ON payouts(redemption_id) WHERE status IN ('draft','pending_approval','approved','processing');
CREATE UNIQUE INDEX payouts_payment_ref ON payouts(payment_ref) WHERE payment_ref IS NOT NULL;
CREATE TABLE payout_events (
  id bigserial PRIMARY KEY, payout_id bigint NOT NULL REFERENCES payouts, from_status text, to_status text NOT NULL, actor uuid NOT NULL REFERENCES users,
  note text, at timestamptz NOT NULL DEFAULT now());
CREATE TRIGGER payout_events_immutable BEFORE UPDATE OR DELETE ON payout_events FOR EACH ROW EXECUTE FUNCTION fin_record_immutable();
-- Rollback (only while empty): DROP TABLE payout_events, payouts; DROP SEQUENCE gl_po_seq;
