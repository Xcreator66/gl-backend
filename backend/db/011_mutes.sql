-- v0.15: mute (one-way, silent: you stop seeing them, they are not told and can still see you; unlike block it keeps follows).
CREATE TABLE IF NOT EXISTS mutes (muter uuid NOT NULL REFERENCES users, muted uuid NOT NULL REFERENCES users, PRIMARY KEY (muter, muted), CHECK (muter<>muted));
CREATE INDEX IF NOT EXISTS comments_post ON comments(post_id, id);
CREATE INDEX IF NOT EXISTS follows_followee ON follows(followee);
