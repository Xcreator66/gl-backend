-- No address is stored here on purpose (privacy). Collector matching/assignment comes in a later phase.
CREATE TABLE pickup_requests (
  id bigserial PRIMARY KEY, user_id uuid NOT NULL REFERENCES users, material_id text NOT NULL REFERENCES materials,
  mode text NOT NULL CHECK (mode IN ('pickup','deposit')), est_grams int CHECK (est_grams>0),
  window_text text CHECK (char_length(window_text)<=80), state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','assigned','done','cancelled')),
  created_at timestamptz DEFAULT now());
