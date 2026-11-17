-- v0.12: collectors can claim household collection requests. No address is stored (privacy); the
-- household and collector arrange the time through the request's window_text and in person.
ALTER TABLE pickup_requests
  ADD COLUMN IF NOT EXISTS assigned_to uuid REFERENCES users,
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz,
  ADD COLUMN IF NOT EXISTS done_at timestamptz;
-- An assigned request must always name its collector.
ALTER TABLE pickup_requests ADD CONSTRAINT pickup_assigned_has_collector
  CHECK (state NOT IN ('assigned') OR assigned_to IS NOT NULL);
CREATE INDEX IF NOT EXISTS pickup_open_idx ON pickup_requests(id) WHERE state='open';
CREATE INDEX IF NOT EXISTS pickup_assigned_idx ON pickup_requests(assigned_to) WHERE state='assigned';
