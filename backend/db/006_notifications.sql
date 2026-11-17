CREATE TABLE notifications (id bigserial PRIMARY KEY, user_id uuid NOT NULL REFERENCES users, kind text NOT NULL, title text NOT NULL, body text NOT NULL,
  read_at timestamptz, pushed_at timestamptz, created_at timestamptz DEFAULT now());
CREATE INDEX notifications_user ON notifications(user_id, id DESC);
CREATE TABLE push_tokens (token text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users, platform text, created_at timestamptz DEFAULT now());
