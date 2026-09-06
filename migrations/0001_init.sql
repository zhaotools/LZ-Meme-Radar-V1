CREATE TABLE IF NOT EXISTS tokens (
  address TEXT PRIMARY KEY,
  chain_id TEXT NOT NULL DEFAULT '56',
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  lane TEXT NOT NULL,
  source TEXT NOT NULL,
  pair_address TEXT,
  discovered_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  latest_score INTEGER NOT NULL,
  latest_level TEXT NOT NULL,
  security_status TEXT NOT NULL,
  latest_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tokens_observed ON tokens(observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_tokens_level ON tokens(latest_level, latest_score DESC);

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  score INTEGER NOT NULL,
  level TEXT NOT NULL,
  security_status TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snapshots_token_time ON snapshots(address, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_retention ON snapshots(observed_at);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL,
  message TEXT NOT NULL,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_alerts_token_type ON alerts(address, alert_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at DESC);

CREATE TABLE IF NOT EXISTS scan_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  discovered_count INTEGER NOT NULL DEFAULT 0,
  scored_count INTEGER NOT NULL DEFAULT 0,
  alert_count INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE TABLE IF NOT EXISTS scanner_state (
  state_key TEXT PRIMARY KEY,
  state_value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
