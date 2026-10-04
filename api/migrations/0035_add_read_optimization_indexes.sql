-- Cut D1 rows_read (free tier limit was being exceeded).
--
-- 1. Indexes for /contributors/:id/templates. The old LEFT JOIN plan scanned
--    submissions once per template row (~4.5k x ~2.4k = ~11M rows read per
--    request). These let both halves of the rewritten query seek directly.
CREATE INDEX IF NOT EXISTS idx_templates_submitted_by
  ON templates(submitted_by)
  WHERE submitted_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_submissions_user_status
  ON submissions(user_id, status, action, template_id);

-- 2. Indexes for the opportunistic cleanup DELETEs in /health, which
--    otherwise full-scan each table on every health check.
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_magic_links_expires ON magic_links(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);

-- 3. Library version counter backing the ETag on /templates and
--    /templates/summary. Bumped by the API on any successful template
--    mutation; a matching If-None-Match turns a ~4.5k-row scan into a
--    single-row read + 304.
CREATE TABLE IF NOT EXISTS library_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO library_meta (id, version) VALUES (1, 1);
