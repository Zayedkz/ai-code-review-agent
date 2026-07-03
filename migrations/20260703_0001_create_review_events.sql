CREATE TABLE IF NOT EXISTS review_events (
  id BIGSERIAL PRIMARY KEY,
  delivery_id TEXT NOT NULL UNIQUE,
  repository TEXT NOT NULL,
  repository_url TEXT NOT NULL,
  pull_request_number INTEGER NOT NULL,
  action TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  event JSONB NOT NULL,
  review JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_review_events_repository_pr
  ON review_events (repository, pull_request_number);

CREATE INDEX IF NOT EXISTS idx_review_events_head_sha
  ON review_events (head_sha);

CREATE INDEX IF NOT EXISTS idx_review_events_risk_level
  ON review_events (risk_level);
