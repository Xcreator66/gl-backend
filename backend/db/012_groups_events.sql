-- v0.16: groups (societies, colleges, neighbourhoods) and events. Groups are created by moderators and joined with a code.
-- Membership is visible only to co-members; cross-group rankings only include groups with enough members to protect individuals.
ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS join_code text UNIQUE,
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users;
ALTER TABLE communities ADD CONSTRAINT community_name_len CHECK (char_length(name) BETWEEN 3 AND 60);
ALTER TABLE community_members ADD COLUMN IF NOT EXISTS joined_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS community_members_user ON community_members(user_id);
-- events.community_id stays nullable: NULL = open to everyone.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS description text CHECK (char_length(description)<=500),
  ADD COLUMN IF NOT EXISTS location_text text CHECK (char_length(location_text)<=120),
  ADD COLUMN IF NOT EXISTS cancelled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users;
CREATE TABLE IF NOT EXISTS event_rsvps (event_id bigint NOT NULL REFERENCES events ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users, PRIMARY KEY (event_id, user_id));
CREATE INDEX IF NOT EXISTS events_starts ON events(starts_at);
