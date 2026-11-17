-- v0.13: OTPs and rate limits live in Postgres so restarts do not wipe them and several backend instances can share them.
-- OTP codes are stored only as HMAC hashes. Everything here is disposable state (safe to truncate).
CREATE TABLE IF NOT EXISTS otp_codes (
  phone text PRIMARY KEY, code_hash text NOT NULL, expires_at timestamptz NOT NULL, tries int NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS rate_limits (
  key text PRIMARY KEY, window_start timestamptz NOT NULL DEFAULT now(), hits int NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS rate_limits_window ON rate_limits(window_start);
