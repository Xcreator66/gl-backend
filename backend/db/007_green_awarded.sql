-- Freeze the GREEN amount at verification so later rate changes can never unbalance pending/approved ledger moves.
ALTER TABLE collections ADD COLUMN green_awarded bigint;
UPDATE collections c SET green_awarded=(c.accepted_grams*m.green_per_kg/1000) FROM materials m WHERE m.id=c.material_id AND c.accepted_grams IS NOT NULL;
