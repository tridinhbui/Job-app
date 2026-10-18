-- Prevents overlapping matching runs for the same user (a run spans several queue messages).
ALTER TABLE profiles ADD COLUMN match_lease_until INTEGER NOT NULL DEFAULT 0;
