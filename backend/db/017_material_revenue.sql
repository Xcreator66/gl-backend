-- What the recycler pays per material for a verified batch (INR, in paise). Separate from the GREEN ledger: this is platform revenue, not a reward.
CREATE TABLE material_revenue (
  id bigserial PRIMARY KEY, batch_id uuid NOT NULL REFERENCES batches, material_id text NOT NULL REFERENCES materials,
  accepted_grams int NOT NULL CHECK (accepted_grams>=0), rate_paise_per_kg int NOT NULL CHECK (rate_paise_per_kg>0), amount_paise bigint NOT NULL CHECK (amount_paise>=0),
  settled_at timestamptz, settlement_ref text CHECK (char_length(settlement_ref)<=60), recorded_by uuid REFERENCES users, created_at timestamptz DEFAULT now(),
  UNIQUE (batch_id, material_id));
