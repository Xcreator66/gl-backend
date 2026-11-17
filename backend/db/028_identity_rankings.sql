-- v0.32.0: Green Identity rankings - self-declared coarse location, immutable historical leaderboard snapshots.
-- Additive only. XP, levels, ranks and titles stay reputation: nothing here reads or writes ledger_entries or GREEN.

-- Coarse, optional, self-declared home area. State comes from a fixed list (ISO 3166-2:IN suffix); city is free text kept with a normalised key.
-- It is used only to place the user on state/city leaderboards, which are shown only when enough people take part (see MIN_GEO_PARTICIPANTS).
ALTER TABLE users ADD COLUMN home_state text CHECK (home_state IS NULL OR home_state ~ '^[A-Z]{2}$');
ALTER TABLE users ADD COLUMN home_city text CHECK (home_city IS NULL OR char_length(home_city) BETWEEN 2 AND 60);
ALTER TABLE users ADD COLUMN home_city_key text CHECK (home_city_key IS NULL OR char_length(home_city_key) BETWEEN 2 AND 60);
ALTER TABLE users ADD CONSTRAINT home_city_pair CHECK ((home_city IS NULL) = (home_city_key IS NULL));
ALTER TABLE users ADD CONSTRAINT home_city_needs_state CHECK (home_city IS NULL OR home_state IS NOT NULL);
CREATE INDEX users_home_state ON users(home_state) WHERE home_state IS NOT NULL;

-- One run per closed period. Periods are Asia/Kolkata calendar weeks (Monday start) or calendar months, stored as UTC instants.
CREATE TABLE leaderboard_snapshot_runs (
  id bigserial PRIMARY KEY, period_kind text NOT NULL CHECK (period_kind IN ('weekly','monthly')),
  period_start timestamptz NOT NULL, period_end timestamptz NOT NULL CHECK (period_end > period_start),
  created_by uuid REFERENCES users, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (period_kind, period_start));
-- Top 50 per audience and scope. scope_kind india -> scope_value ''; state -> 'PB'; city -> 'PB:jandiala' (state-qualified so same-named cities never merge).
-- Only people who had not opted out and were not deleted at snapshot time are stored; reads filter again, so a later opt-out or deletion removes the name.
CREATE TABLE leaderboard_snapshots (
  run_id bigint NOT NULL REFERENCES leaderboard_snapshot_runs, audience text NOT NULL CHECK (audience IN ('individual','collector')),
  scope_kind text NOT NULL CHECK (scope_kind IN ('india','state','city')), scope_value text NOT NULL DEFAULT '',
  user_id uuid NOT NULL REFERENCES users, position int NOT NULL CHECK (position >= 1), xp int NOT NULL CHECK (xp > 0), participants int NOT NULL CHECK (participants >= 1),
  PRIMARY KEY (run_id, audience, scope_kind, scope_value, user_id));
CREATE INDEX leaderboard_snapshots_board ON leaderboard_snapshots(run_id, audience, scope_kind, scope_value, position);
CREATE INDEX leaderboard_snapshots_user ON leaderboard_snapshots(user_id, run_id);
-- History is not rewritten. A mistaken run is corrected by a new, clearly dated process, never by editing rows.
CREATE TRIGGER leaderboard_snapshot_runs_immutable BEFORE UPDATE OR DELETE ON leaderboard_snapshot_runs FOR EACH ROW EXECUTE FUNCTION fin_record_immutable();
CREATE TRIGGER leaderboard_snapshots_immutable BEFORE UPDATE OR DELETE ON leaderboard_snapshots FOR EACH ROW EXECUTE FUNCTION fin_record_immutable();
-- Rollback (only while empty): DROP TABLE leaderboard_snapshots, leaderboard_snapshot_runs; ALTER TABLE users DROP COLUMN home_city_key, DROP COLUMN home_city, DROP COLUMN home_state;
