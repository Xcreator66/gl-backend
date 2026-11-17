CREATE TABLE commissions (
  id bigserial PRIMARY KEY, batch_id uuid NOT NULL REFERENCES batches, collector_id uuid NOT NULL REFERENCES users,
  green bigint NOT NULL CHECK (green>0), state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','reversed')),
  decided_by uuid REFERENCES users, decided_at timestamptz, created_at timestamptz DEFAULT now());
