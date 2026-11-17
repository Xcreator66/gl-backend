-- v0.29.0: tamper protection. Adds triggers only; no data is changed. Safe on a populated database.
-- 1) The ledger already blocks row UPDATE/DELETE; TRUNCATE bypasses row triggers, so block it too (reuses ledger_immutable() from schema.sql).
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_immutable();
-- 2) The audit trail must be append-only as well. Nothing in the application updates or deletes audit_log rows.
CREATE FUNCTION audit_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_no_change BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_immutable();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_immutable();
-- Rollback: DROP TRIGGER audit_no_truncate ON audit_log; DROP TRIGGER audit_no_change ON audit_log; DROP FUNCTION audit_immutable();
--           DROP TRIGGER ledger_no_truncate ON ledger_entries;   (and remove those names from scripts/integrity.sql)
