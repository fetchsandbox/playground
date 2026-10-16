-- Customer handoff (CRM -> billing -> welcome email) and the agent action log.

-- One handoff run per quote: the UNIQUE constraint is what makes a repeated
-- or concurrent "start handoff" return the existing run instead of a second one.
CREATE TABLE IF NOT EXISTS handoff_runs (
    id TEXT PRIMARY KEY,
    quote_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    paused INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS handoff_runs_by_created ON handoff_runs (created_at);

-- Steps change state with conditional UPDATEs (claim pending -> running, etc.),
-- so two workers can never execute the same step at once.
CREATE TABLE IF NOT EXISTS handoff_steps (
    run_id TEXT NOT NULL,
    name TEXT NOT NULL,
    seq INTEGER NOT NULL,
    agent TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (run_id, name)
);
CREATE INDEX IF NOT EXISTS handoff_steps_by_status ON handoff_steps (status, updated_at);

-- Append-only: the application only ever INSERTs here.
CREATE TABLE IF NOT EXISTS agent_actions (
    id TEXT PRIMARY KEY,
    run_id TEXT,
    step TEXT,
    agent TEXT NOT NULL,
    action TEXT NOT NULL,
    outcome TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    detail TEXT NOT NULL,
    created_at TEXT NOT NULL,
    seq BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_actions_by_run ON agent_actions (run_id, seq);
CREATE INDEX IF NOT EXISTS agent_actions_by_seq ON agent_actions (seq);
