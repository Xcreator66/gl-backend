CREATE SEQUENCE gl_p_seq START 100001;
CREATE TABLE redemptions (
  id bigserial PRIMARY KEY, public_id text UNIQUE NOT NULL, idempotency_key text UNIQUE NOT NULL,
  user_id uuid NOT NULL REFERENCES users, green bigint NOT NULL CHECK (green>0), amount_paise bigint NOT NULL CHECK (amount_paise>0),
  payout_handle text NOT NULL, state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','paid','rejected')),
  utr text, reject_reason text, decided_by uuid REFERENCES users, decided_at timestamptz, created_at timestamptz DEFAULT now());
