"""SQLite persistence: workflow runs, quotes, approvals, dedupe keys.

Runs and approvals are persisted so a workflow paused on a manager's
approval survives a restart and resumes when the Slack button is clicked.
"""

import json
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any

from .models import Quote

SCHEMA = """
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
CREATE TABLE IF NOT EXISTS quotes (
    id TEXT PRIMARY KEY,
    customer_email TEXT NOT NULL,
    status TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS quotes_by_customer ON quotes (customer_email, created_at);
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
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, path: str):
        self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._conn.executescript(SCHEMA)

    def _exec(self, sql: str, args: tuple = ()) -> sqlite3.Cursor:
        with self._lock:
            return self._conn.execute(sql, args)

    # --- dedupe -------------------------------------------------------------

    def claim_event(self, key: str) -> bool:
        """True the first time a key is seen; False for every redelivery."""
        cur = self._exec(
            "INSERT OR IGNORE INTO processed_events (key, created_at) VALUES (?, ?)",
            (key, now_iso()),
        )
        return cur.rowcount == 1

    # --- runs ---------------------------------------------------------------

    def save_run(self, run: dict[str, Any]) -> None:
        ts = now_iso()
        run["updated_at"] = ts
        run.setdefault("created_at", ts)
        self._exec(
            "INSERT INTO runs (id, status, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET status=excluded.status, data=excluded.data, updated_at=excluded.updated_at",
            (run["id"], run["status"], json.dumps(run), run["created_at"], ts),
        )

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        row = self._exec("SELECT data FROM runs WHERE id = ?", (run_id,)).fetchone()
        return json.loads(row["data"]) if row else None

    def list_runs(self, limit: int = 50) -> list[dict[str, Any]]:
        rows = self._exec("SELECT data FROM runs ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
        return [json.loads(r["data"]) for r in rows]

    # --- quotes -------------------------------------------------------------

    def save_quote(self, quote: Quote) -> None:
        self._exec(
            "INSERT INTO quotes (id, customer_email, status, data, created_at) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET status=excluded.status, data=excluded.data",
            (quote.id, quote.customer_email.lower(), quote.status, quote.model_dump_json(), quote.created_at),
        )

    def get_quote(self, quote_id: str) -> Quote | None:
        row = self._exec("SELECT data FROM quotes WHERE id = ?", (quote_id.upper(),)).fetchone()
        return Quote.model_validate_json(row["data"]) if row else None

    def latest_sent_quote(self, customer_email: str) -> Quote | None:
        row = self._exec(
            "SELECT data FROM quotes WHERE customer_email = ? AND status = 'sent' "
            "ORDER BY created_at DESC, rowid DESC LIMIT 1",
            (customer_email.lower(),),
        ).fetchone()
        return Quote.model_validate_json(row["data"]) if row else None

    def list_quotes(self, limit: int = 50) -> list[Quote]:
        rows = self._exec("SELECT data FROM quotes ORDER BY created_at DESC, rowid DESC LIMIT ?", (limit,)).fetchall()
        return [Quote.model_validate_json(r["data"]) for r in rows]

    # --- approvals ----------------------------------------------------------

    def create_approval(self, approval_id: str, run_id: str, data: dict[str, Any]) -> None:
        self._exec(
            "INSERT INTO approvals (id, run_id, status, data, created_at) VALUES (?, ?, 'pending', ?, ?)",
            (approval_id, run_id, json.dumps(data), now_iso()),
        )

    def get_approval(self, approval_id: str) -> dict[str, Any] | None:
        row = self._exec("SELECT * FROM approvals WHERE id = ?", (approval_id,)).fetchone()
        if not row:
            return None
        return {**json.loads(row["data"]), "id": row["id"], "run_id": row["run_id"],
                "status": row["status"], "decided_at": row["decided_at"]}

    def update_approval_data(self, approval_id: str, data: dict[str, Any]) -> None:
        self._exec("UPDATE approvals SET data = ? WHERE id = ?", (json.dumps(data), approval_id))

    def decide_approval(self, approval_id: str, decision: str) -> bool:
        """Atomically move pending -> decision. False if already decided."""
        cur = self._exec(
            "UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
            (decision, now_iso(), approval_id),
        )
        return cur.rowcount == 1

    # --- kv -----------------------------------------------------------------

    def get_kv(self, key: str) -> str | None:
        row = self._exec("SELECT value FROM kv WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None

    def set_kv(self, key: str, value: str) -> None:
        self._exec(
            "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )
