-- v2: onboarding, locale/timezone, daily digest, skip feedback, adapter health.
ALTER TABLE profiles ADD COLUMN locale TEXT NOT NULL DEFAULT 'vi';
ALTER TABLE profiles ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE profiles ADD COLUMN onboarded_at INTEGER;
ALTER TABLE profiles ADD COLUMN last_digest_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE matches ADD COLUMN skip_reason TEXT;

-- Result of the weekly dry-run probe of each ATS form (detects DOM changes).
CREATE TABLE adapter_health (
  ats         TEXT PRIMARY KEY,
  checked_at  INTEGER NOT NULL,
  fill_ratio  REAL NOT NULL,
  ok          INTEGER NOT NULL,
  message     TEXT
);
