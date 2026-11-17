-- Account deletion = erasure of personal data, NOT deletion of the row: the ledger is append-only and money records must stay.
ALTER TABLE users ADD COLUMN deleted_at timestamptz;
ALTER TABLE users ADD CONSTRAINT deleted_has_no_phone CHECK (deleted_at IS NULL OR phone LIKE 'deleted:%');
