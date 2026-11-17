-- Batch handover to an authorised recycler + per-material received/rejected records.
ALTER TABLE batches ADD COLUMN handover_to uuid REFERENCES users, ADD COLUMN handed_over_at timestamptz;
CREATE TABLE batch_checks (
  batch_id uuid NOT NULL REFERENCES batches, material_id text NOT NULL REFERENCES materials,
  received_grams int NOT NULL CHECK (received_grams>=0), rejected_grams int NOT NULL DEFAULT 0 CHECK (rejected_grams>=0),
  reject_reason text CHECK (reject_reason IN ('contaminated','wrong_material','wet','other')), note text CHECK (char_length(note)<=200),
  PRIMARY KEY (batch_id, material_id), CHECK (rejected_grams<=received_grams), CHECK (rejected_grams=0 OR reject_reason IS NOT NULL));
-- PLACEHOLDER limit (share of received weight rejected before a batch is flagged for admin review). Confirm with your recycler.
UPDATE materials SET max_contamination_pct=10 WHERE max_contamination_pct IS NULL;
