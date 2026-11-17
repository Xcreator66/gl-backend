CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TYPE user_role AS ENUM ('individual','collector','recycler','admin');
CREATE TYPE reward_state AS ENUM ('pending','approved','adjusted','redeemed');
CREATE SEQUENCE gl_u_seq START 100001; CREATE SEQUENCE gl_c_seq START 100001;
CREATE SEQUENCE gl_b_seq START 100001; CREATE SEQUENCE gl_t_seq START 100001;
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text UNIQUE NOT NULL, role user_role NOT NULL,
  phone text UNIQUE NOT NULL, display_name text, created_at timestamptz DEFAULT now());
CREATE TABLE materials (
  id text PRIMARY KEY, name text NOT NULL, green_per_kg int NOT NULL CHECK (green_per_kg>=0),
  acceptance_rules jsonb DEFAULT '{}', max_contamination_pct numeric, active boolean DEFAULT true);
INSERT INTO materials(id,name,green_per_kg) VALUES
 ('PET','PET bottles',40),('ALU','Aluminium cans',150),('GLS','Glass bottles',10),
 ('PLS','Other recyclable plastics',20),('PAP','Paper and cardboard',8);
CREATE TABLE batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), public_id text UNIQUE NOT NULL,
  collector_id uuid NOT NULL REFERENCES users, recycler_id uuid REFERENCES users,
  status text NOT NULL DEFAULT 'open', verified_grams int, created_at timestamptz DEFAULT now());
CREATE TABLE collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), public_id text UNIQUE NOT NULL,
  idempotency_key text UNIQUE NOT NULL,
  household_id uuid NOT NULL REFERENCES users, collector_id uuid NOT NULL REFERENCES users,
  material_id text NOT NULL REFERENCES materials, batch_id uuid REFERENCES batches,
  declared_grams int NOT NULL CHECK (declared_grams>0), accepted_grams int,
  state reward_state NOT NULL DEFAULT 'pending', synced_offline boolean DEFAULT false,
  created_at timestamptz DEFAULT now());
-- Double-entry, append-only ledger: entries of each txn_id must net to zero.
CREATE TABLE ledger_entries (
  id bigserial PRIMARY KEY, txn_id uuid NOT NULL, account text NOT NULL,
  amount_green bigint NOT NULL, ref_collection uuid REFERENCES collections,
  memo text, created_at timestamptz DEFAULT now());
CREATE FUNCTION ledger_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'ledger_entries is append-only'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_no_change BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_immutable();
CREATE FUNCTION ledger_balanced() RETURNS trigger AS $$
BEGIN IF (SELECT sum(amount_green) FROM ledger_entries WHERE txn_id=NEW.txn_id)<>0
 THEN RAISE EXCEPTION 'unbalanced ledger txn %', NEW.txn_id; END IF; RETURN NULL; END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER ledger_balance AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_balanced();
CREATE TABLE audit_log (id bigserial PRIMARY KEY, actor uuid, action text, detail jsonb, at timestamptz DEFAULT now());
-- Supabase RLS: users read only their own rows; writes go through backend service role.
ALTER TABLE collections ENABLE ROW LEVEL SECURITY; -- plain Postgres: backend role bypasses/owns; Supabase: policy below
DO $$ BEGIN IF to_regnamespace('auth') IS NOT NULL THEN
  EXECUTE 'CREATE POLICY own_collections ON collections FOR SELECT USING (household_id = auth.uid() OR collector_id = auth.uid())';
END IF; END $$;
