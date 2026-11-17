-- v0.31.0: secure media attachments, 24-hour Stories, story interactions and saved posts.
-- Media binaries stay outside PostgreSQL in private storage. Database rows contain metadata and opaque storage keys only.

ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_body_check;
ALTER TABLE posts ADD CONSTRAINT posts_body_check CHECK (char_length(body) BETWEEN 0 AND 500);
ALTER TABLE posts ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE posts ADD COLUMN IF NOT EXISTS edited_at timestamptz;

CREATE TABLE media_assets (
  id bigserial PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id),
  storage_key text NOT NULL UNIQUE CHECK (storage_key ~ '^[a-f0-9-]{36}$'),
  media_kind text NOT NULL CHECK (media_kind IN ('image','video')),
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp','video/mp4','video/quicktime')),
  byte_size bigint NOT NULL CHECK (byte_size > 0 AND byte_size <= 125829120),
  width int CHECK (width IS NULL OR width BETWEEN 1 AND 12000),
  height int CHECK (height IS NULL OR height BETWEEN 1 AND 12000),
  duration_ms int CHECK (duration_ms IS NULL OR duration_ms BETWEEN 1 AND 120000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','removed')),
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  uploaded_at timestamptz,
  removed_at timestamptz
);
CREATE INDEX media_assets_owner_status ON media_assets(owner_id,status,created_at DESC);
CREATE INDEX media_assets_pending ON media_assets(created_at) WHERE status='pending';

CREATE TABLE post_attachments (
  id bigserial PRIMARY KEY,
  post_id bigint NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  asset_id bigint NOT NULL UNIQUE REFERENCES media_assets(id),
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 7),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(post_id,position)
);
CREATE INDEX post_attachments_post ON post_attachments(post_id,position);

CREATE TABLE stories (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  body text CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 300),
  audience text NOT NULL DEFAULT 'everyone' CHECK (audience IN ('everyone','followers','group')),
  audience_group_id bigint REFERENCES communities(id),
  shared_post_id bigint REFERENCES posts(id),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  hidden boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((audience='group' AND audience_group_id IS NOT NULL) OR (audience<>'group' AND audience_group_id IS NULL)),
  CHECK (expires_at <= created_at + interval '24 hours 1 minute')
);
CREATE INDEX stories_live ON stories(expires_at DESC, user_id) WHERE NOT hidden;
CREATE INDEX stories_user_live ON stories(user_id,created_at DESC) WHERE NOT hidden;

CREATE TABLE story_attachments (
  id bigserial PRIMARY KEY,
  story_id bigint NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  asset_id bigint NOT NULL UNIQUE REFERENCES media_assets(id),
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(story_id,position)
);
CREATE INDEX story_attachments_story ON story_attachments(story_id,position);

CREATE TABLE story_views (
  story_id bigint NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  viewer_id uuid NOT NULL REFERENCES users(id),
  viewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(story_id,viewer_id)
);
CREATE INDEX story_views_story_time ON story_views(story_id,viewed_at DESC);

CREATE TABLE story_reactions (
  story_id bigint NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  reaction text NOT NULL CHECK (reaction IN ('like','love','clap','leaf')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(story_id,user_id)
);

CREATE TABLE story_replies (
  id bigserial PRIMARY KEY,
  story_id bigint NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 250),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX story_replies_story ON story_replies(story_id,created_at);

CREATE TABLE story_reports (
  id bigserial PRIMARY KEY,
  story_id bigint NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  reporter uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE(story_id,reporter)
);
CREATE INDEX story_reports_open ON story_reports(created_at DESC) WHERE resolved_at IS NULL;

CREATE TABLE saved_posts (
  user_id uuid NOT NULL REFERENCES users(id),
  post_id bigint NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  saved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,post_id)
);

-- A photo-only post is now valid; API validation still requires at least one caption character OR an attachment.
-- Never award GREEN or XP from any table in this migration.
