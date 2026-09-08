ALTER TABLE scan_runs ADD COLUMN queued_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scan_runs ADD COLUMN tracked_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scan_runs ADD COLUMN source_status_json TEXT;

CREATE TABLE IF NOT EXISTS candidate_queue (
  address TEXT PRIMARY KEY,
  candidate_json TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  source_created_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_scored_at TEXT,
  next_scan_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_candidate_queue_due
  ON candidate_queue(status, next_scan_at, priority DESC);
CREATE INDEX IF NOT EXISTS idx_candidate_queue_expiry
  ON candidate_queue(expires_at);

CREATE TABLE IF NOT EXISTS source_health (
  source TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  last_attempt_at TEXT NOT NULL,
  last_success_at TEXT,
  last_error TEXT,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_source_health_status
  ON source_health(status, last_attempt_at DESC);
