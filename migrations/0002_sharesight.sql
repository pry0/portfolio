CREATE TABLE IF NOT EXISTS sharesight_runs(
  id TEXT PRIMARY KEY, source_user_id TEXT NOT NULL, status TEXT NOT NULL,
  as_of TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  token_cipher TEXT, token_expires INTEGER, lock_owner TEXT, locked_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sharesight_jobs(
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES sharesight_runs(id),
  path TEXT NOT NULL, category TEXT NOT NULL, portfolio_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  http_status INTEGER, message TEXT, retry_after INTEGER NOT NULL DEFAULT 0,
  record_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  UNIQUE(run_id,path)
);
CREATE INDEX IF NOT EXISTS sharesight_jobs_queue ON sharesight_jobs(run_id,status,retry_after);
CREATE TABLE IF NOT EXISTS sharesight_responses(
  id TEXT PRIMARY KEY REFERENCES sharesight_jobs(id), run_id TEXT NOT NULL REFERENCES sharesight_runs(id),
  sha256 TEXT NOT NULL, byte_count INTEGER NOT NULL, content_type TEXT NOT NULL,
  headers_json TEXT NOT NULL, fetched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sharesight_chunks(
  response_id TEXT NOT NULL REFERENCES sharesight_responses(id), chunk_index INTEGER NOT NULL,
  base64 TEXT NOT NULL, PRIMARY KEY(response_id,chunk_index)
);
CREATE TABLE IF NOT EXISTS sharesight_records(
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES sharesight_runs(id),
  source_key TEXT NOT NULL, source_id TEXT, kind TEXT NOT NULL,
  portfolio_id TEXT, holding_id TEXT, occurred_on TEXT, label TEXT NOT NULL,
  source_state TEXT, raw_json TEXT NOT NULL, response_id TEXT NOT NULL REFERENCES sharesight_responses(id),
  UNIQUE(run_id,source_key)
);
CREATE INDEX IF NOT EXISTS sharesight_records_browse ON sharesight_records(run_id,kind,portfolio_id,id);
