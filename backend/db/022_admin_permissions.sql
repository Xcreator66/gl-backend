-- v0.30.0: explicit finance permissions. A tier alone no longer lets anyone approve or execute payouts; super does NOT imply these either.
CREATE TABLE admin_permissions (
  user_id uuid NOT NULL REFERENCES users, permission text NOT NULL CHECK (permission IN
    ('payout.prepare','payout.approve','payout.execute','finance.audit','commission.override_reversal','role.override')),
  granted_by uuid NOT NULL REFERENCES users, granted_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, permission));
-- Grants and revocations are recorded in audit_log (append-only). Rows are removed when a user stops being an admin.
