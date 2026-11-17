-- v0.19.0: role-based public IDs. Collectors get GL-C-xxxxxxxxk, recyclers GL-R-xxxxxxxxk.
-- The 8 characters are random (40 bits, from a 32-symbol alphabet without I, L, O, U; typed O/I/L are read as 0/1/1), so IDs cannot be guessed or counted
-- the way the sequential GL-U- numbers can. The last character is a Luhn mod-32 check character, so a mistyped or mis-scanned ID is
-- rejected before any database lookup. Households keep their GL-U- ID. No personal data is encoded in any ID.
-- The algorithm MUST match backend/src/roleIds.ts (a database test checks both agree).
ALTER TABLE users ADD COLUMN IF NOT EXISTS role_id text UNIQUE;

CREATE FUNCTION gl_role_check(body text) RETURNS text AS $$
DECLARE alpha constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; n constant int := 32;
  factor int := 2; total int := 0; cp int; addend int; i int;
BEGIN
  FOR i IN REVERSE char_length(body)..1 LOOP
    cp := strpos(alpha, substr(body, i, 1)) - 1;
    IF cp < 0 THEN RAISE EXCEPTION 'bad role id character'; END IF;
    addend := factor * cp; factor := CASE WHEN factor = 2 THEN 1 ELSE 2 END;
    total := total + (addend / n) + (addend % n);
  END LOOP;
  RETURN substr(alpha, ((n - (total % n)) % n) + 1, 1);
END $$ LANGUAGE plpgsql IMMUTABLE;

CREATE FUNCTION gl_new_role_id(prefix text) RETURNS text AS $$
DECLARE alpha constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; body text; bytes bytea; i int; cand text;
BEGIN
  IF prefix NOT IN ('GL-C-', 'GL-R-') THEN RAISE EXCEPTION 'bad role id prefix'; END IF;
  LOOP
    bytes := gen_random_bytes(8); body := '';
    FOR i IN 0..7 LOOP body := body || substr(alpha, (get_byte(bytes, i) % 32) + 1, 1); END LOOP; -- 256 % 32 = 0, so no modulo bias
    cand := prefix || body || gl_role_check(body);
    IF NOT EXISTS (SELECT 1 FROM users WHERE role_id = cand) THEN RETURN cand; END IF;
  END LOOP;
END $$ LANGUAGE plpgsql VOLATILE;

-- Backfill existing collectors and recyclers.
UPDATE users SET role_id = gl_new_role_id('GL-C-') WHERE role = 'collector' AND role_id IS NULL;
UPDATE users SET role_id = gl_new_role_id('GL-R-') WHERE role = 'recycler' AND role_id IS NULL;

-- A role ID exists only for the matching current role. Granting a role by SQL needs the ID too:
--   UPDATE users SET role='recycler', role_id=gl_new_role_id('GL-R-') WHERE phone='+91...';
ALTER TABLE users ADD CONSTRAINT role_id_matches_role CHECK (
  (role = 'collector' AND role_id ~ '^GL-C-[0-9A-HJKMNP-TV-Z]{9}$') OR
  (role = 'recycler'  AND role_id ~ '^GL-R-[0-9A-HJKMNP-TV-Z]{9}$') OR
  (role IN ('individual','admin') AND role_id IS NULL));
