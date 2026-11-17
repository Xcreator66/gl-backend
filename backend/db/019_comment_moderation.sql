-- v0.27: comment reports and moderator tools (hide, restore, dismiss).
-- mod_hidden_at marks content a MODERATOR hid. Only that can be restored: content the author deleted, or erased by account deletion, stays hidden.
CREATE TABLE comment_reports (
  id bigserial PRIMARY KEY, comment_id bigint NOT NULL REFERENCES comments, reporter uuid NOT NULL REFERENCES users,
  reason text CHECK (char_length(reason) <= 200), created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz,
  UNIQUE (comment_id, reporter));
CREATE INDEX comment_reports_open ON comment_reports(comment_id) WHERE resolved_at IS NULL;
ALTER TABLE reports  ADD COLUMN resolved_at timestamptz;
ALTER TABLE posts    ADD COLUMN mod_hidden_at timestamptz;
ALTER TABLE comments ADD COLUMN mod_hidden_at timestamptz;
-- Existing data: posts hidden through the old moderator button are recorded in audit_log; their reports are finished business.
UPDATE posts SET mod_hidden_at = now() WHERE hidden AND id::text IN (SELECT detail->>'post' FROM audit_log WHERE action = 'post.hide');
UPDATE reports SET resolved_at = now() WHERE post_id IN (SELECT id FROM posts WHERE hidden);
