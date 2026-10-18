-- v3: duplicate-submission locks, run log (monitoring), quality reports, semantic matching.

-- One row per (user, role) that has ever had its submit button clicked. The UNIQUE key is the
-- database-level guarantee that the same role is never submitted twice, across retries,
-- timeouts, concurrent workflows and duplicate postings.
CREATE TABLE submission_locks (
  user_id         TEXT NOT NULL,
  dedupe_key      TEXT NOT NULL,
  application_id  TEXT NOT NULL,
  locked_at       INTEGER NOT NULL,
  PRIMARY KEY (user_id, dedupe_key)
);

-- Operational log for monitoring (crawl / match / prepare / fill / submit / digest).
CREATE TABLE runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,
  status          TEXT NOT NULL,              -- ok | error | blocked | partial | ...
  user_id         TEXT,                       -- NULL for shared work (crawls)
  ref_id          TEXT,
  duration_ms     INTEGER,
  metrics_json    TEXT,
  error           TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX runs_kind_time ON runs(kind, created_at);
CREATE INDEX runs_user_time ON runs(user_id, created_at);

ALTER TABLE ai_usage ADD COLUMN application_id TEXT;
CREATE INDEX ai_usage_app ON ai_usage(application_id);

ALTER TABLE applications ADD COLUMN quality_json TEXT;

-- Embeddings for semantic matching (base64 float32), cached by content.
CREATE TABLE job_embeddings (
  job_id        TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  content_hash  TEXT NOT NULL,
  model         TEXT NOT NULL,
  vector        TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
ALTER TABLE profiles ADD COLUMN resume_vector TEXT;
ALTER TABLE profiles ADD COLUMN resume_vector_version INTEGER NOT NULL DEFAULT -1;

-- Re-score existing matches with the v3 model on the next matching run.
UPDATE profiles SET match_watermark = 0;
