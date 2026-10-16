-- Initial schema. Portable across SQLite and PostgreSQL.
-- JSON documents are stored as TEXT; timestamps as ISO-8601 UTC TEXT.

CREATE TABLE IF NOT EXISTS processed_events (
    key TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_by_created ON runs (created_at);
CREATE INDEX IF NOT EXISTS runs_by_status_updated ON runs (status, updated_at);

CREATE TABLE IF NOT EXISTS quotes (
    id TEXT PRIMARY KEY,
    customer_email TEXT NOT NULL,
    status TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    seq BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS quotes_by_customer ON quotes (customer_email, status, created_at);

CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    status TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    decided_at TEXT
);

CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
