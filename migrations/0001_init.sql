-- ApplyPilot schema. All timestamps are unix epoch milliseconds.
-- Sensitive columns (suffix _enc) hold AES-GCM ciphertext produced by worker/lib/crypto.ts.

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);

CREATE TABLE profiles (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  personal_enc       TEXT,                     -- PersonalInfo JSON (encrypted)
  resume_enc         TEXT,                     -- BaseResume JSON (encrypted)
  resume_version     INTEGER NOT NULL DEFAULT 0,
  preferences_json   TEXT NOT NULL DEFAULT '{}',
  answers_enc        TEXT,                     -- saved answer library (encrypted)
  settings_json      TEXT NOT NULL DEFAULT '{}',
  match_watermark    INTEGER NOT NULL DEFAULT 0, -- jobs.updated_at already matched
  updated_at         INTEGER NOT NULL
);

-- Job boards are global: one crawl serves every subscribed user.
CREATE TABLE sources (
  id               TEXT PRIMARY KEY,           -- "<ats>:<token>"
  ats              TEXT NOT NULL CHECK (ats IN ('greenhouse', 'lever', 'ashby', 'jsonld')),
  token            TEXT NOT NULL,
  company_name     TEXT,
  last_crawled_at  INTEGER,
  last_status      TEXT,                       -- ok | error | blocked
  last_error       TEXT,
  job_count        INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  UNIQUE (ats, token)
);

CREATE TABLE user_sources (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id  TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, source_id)
);
CREATE INDEX user_sources_source ON user_sources(source_id);

CREATE TABLE jobs (
  id               TEXT PRIMARY KEY,
  source_id        TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  external_id      TEXT NOT NULL,
  company          TEXT NOT NULL,
  title            TEXT NOT NULL,
  location         TEXT,
  workplace        TEXT,                       -- remote | hybrid | onsite | NULL
  seniority        TEXT,
  employment_type  TEXT,
  department       TEXT,
  salary_min       INTEGER,
  salary_max       INTEGER,
  salary_currency  TEXT,
  salary_period    TEXT,                       -- year | month | hour
  description      TEXT NOT NULL,
  apply_url        TEXT NOT NULL,
  job_url          TEXT NOT NULL,
  posted_at        INTEGER,
  first_seen_at    INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  closed_at        INTEGER,
  status           TEXT NOT NULL DEFAULT 'open', -- open | closed
  content_hash     TEXT NOT NULL,
  dedupe_key       TEXT NOT NULL,
  duplicate_of     TEXT,
  UNIQUE (source_id, external_id)
);
CREATE INDEX jobs_source_status ON jobs(source_id, status);
CREATE INDEX jobs_updated ON jobs(updated_at);
CREATE INDEX jobs_dedupe ON jobs(dedupe_key);

-- Shared, cached JD analysis (heuristic or AI). Invalidated when content_hash changes.
CREATE TABLE job_analysis (
  job_id        TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  content_hash  TEXT NOT NULL,
  method        TEXT NOT NULL,                 -- heuristic | ai
  model         TEXT,
  analysis_json TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

-- Only jobs that pass the user's hard filters are stored.
CREATE TABLE matches (
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  score           INTEGER NOT NULL,
  det_score       INTEGER NOT NULL,
  ai_score        INTEGER,
  reasons_json    TEXT NOT NULL,
  resume_version  INTEGER NOT NULL,
  job_hash        TEXT NOT NULL,
  dismissed       INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, job_id)
);
CREATE INDEX matches_user_score ON matches(user_id, dismissed, score DESC);

CREATE TABLE applications (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id              TEXT NOT NULL REFERENCES jobs(id),
  status              TEXT NOT NULL,
  dedupe_key          TEXT NOT NULL,
  adapter             TEXT,                    -- greenhouse | manual
  tailored_key        TEXT,                    -- R2: tailored resume JSON
  resume_pdf_key      TEXT,                    -- R2: tailored resume PDF
  tailor_method       TEXT,                    -- ai | deterministic
  answers_enc         TEXT,                    -- prepared form answers (encrypted)
  form_json           TEXT,                    -- normalized form schema
  missing_json        TEXT,                    -- required fields still needing user input
  workflow_id         TEXT,
  submit_mode         TEXT,                    -- dry_run | live
  submit_attempts     INTEGER NOT NULL DEFAULT 0,
  clicked_at          INTEGER,                 -- set right before the submit click (double-submit guard)
  submitted_at        INTEGER,
  screenshot_key      TEXT,
  confirmation_text   TEXT,
  error               TEXT,
  notes               TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (user_id, job_id)
);
CREATE INDEX applications_user_status ON applications(user_id, status, updated_at DESC);
CREATE INDEX applications_user_dedupe ON applications(user_id, dedupe_key);

CREATE TABLE application_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id  TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL,
  type            TEXT NOT NULL,               -- status | note | error | info
  from_status     TEXT,
  to_status       TEXT,
  message         TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX application_events_app ON application_events(application_id, id DESC);
CREATE INDEX application_events_user ON application_events(user_id, id DESC);

CREATE TABLE tailored_resumes (
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id          TEXT NOT NULL,
  resume_version  INTEGER NOT NULL,
  job_hash        TEXT NOT NULL,
  method          TEXT NOT NULL,
  json_key        TEXT NOT NULL,
  pdf_key         TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, job_id, resume_version, job_hash)
);

-- AI accounting.
CREATE TABLE ai_usage (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        TEXT,
  month          TEXT NOT NULL,                -- YYYY-MM (UTC)
  task           TEXT NOT NULL,
  model          TEXT NOT NULL,
  input_tokens   INTEGER NOT NULL,
  output_tokens  INTEGER NOT NULL,
  cost_usd       REAL NOT NULL,
  estimated      INTEGER NOT NULL DEFAULT 0,   -- 1 when the model did not report usage
  created_at     INTEGER NOT NULL
);
CREATE INDEX ai_usage_user_month ON ai_usage(user_id, month);

CREATE TABLE ai_budget (
  user_id     TEXT NOT NULL,
  month       TEXT NOT NULL,
  spent_usd   REAL NOT NULL DEFAULT 0,
  calls       INTEGER NOT NULL DEFAULT 0,
  cache_hits  INTEGER NOT NULL DEFAULT 0,
  blocked     INTEGER NOT NULL DEFAULT 0,      -- calls skipped because the budget was exhausted
  PRIMARY KEY (user_id, month)
);

-- Content-addressed cache for AI responses (key = sha256(task|model|prompt)).
CREATE TABLE ai_cache (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
