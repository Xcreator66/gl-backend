-- Community schema. Rewards are never derived from anything here (likes/follows/referrals earn nothing).
CREATE TABLE posts (id bigserial PRIMARY KEY, user_id uuid NOT NULL REFERENCES users, kind text NOT NULL DEFAULT 'text' CHECK (kind IN ('text','achievement')),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500), hidden boolean NOT NULL DEFAULT false, created_at timestamptz DEFAULT now());
CREATE TABLE comments (id bigserial PRIMARY KEY, post_id bigint NOT NULL REFERENCES posts, parent_id bigint REFERENCES comments, user_id uuid NOT NULL REFERENCES users,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 300), hidden boolean NOT NULL DEFAULT false, created_at timestamptz DEFAULT now());
CREATE TABLE post_likes (post_id bigint REFERENCES posts, user_id uuid REFERENCES users, PRIMARY KEY (post_id,user_id));
CREATE TABLE follows (follower uuid REFERENCES users, followee uuid REFERENCES users, PRIMARY KEY (follower,followee), CHECK (follower<>followee));
CREATE TABLE blocks (blocker uuid REFERENCES users, blocked uuid REFERENCES users, PRIMARY KEY (blocker,blocked), CHECK (blocker<>blocked));
CREATE TABLE reports (id bigserial PRIMARY KEY, post_id bigint NOT NULL REFERENCES posts, reporter uuid NOT NULL REFERENCES users, reason text, created_at timestamptz DEFAULT now(), UNIQUE(post_id,reporter));
CREATE TABLE challenges (id bigserial PRIMARY KEY, title text NOT NULL, material_id text REFERENCES materials, target_grams int NOT NULL CHECK (target_grams>0),
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL CHECK (ends_at>starts_at), created_by uuid REFERENCES users);
CREATE TABLE challenge_members (challenge_id bigint REFERENCES challenges, user_id uuid REFERENCES users, PRIMARY KEY (challenge_id,user_id));
-- Tables for later phases (no API yet): groups, events, referrals
CREATE TABLE communities (id bigserial PRIMARY KEY, name text NOT NULL, kind text NOT NULL CHECK (kind IN ('society','college','neighbourhood')), created_at timestamptz DEFAULT now());
CREATE TABLE community_members (community_id bigint REFERENCES communities, user_id uuid REFERENCES users, PRIMARY KEY (community_id,user_id));
CREATE TABLE events (id bigserial PRIMARY KEY, community_id bigint REFERENCES communities, title text NOT NULL, starts_at timestamptz NOT NULL);
CREATE TABLE referrals (referrer uuid REFERENCES users, referred uuid UNIQUE REFERENCES users, created_at timestamptz DEFAULT now());
