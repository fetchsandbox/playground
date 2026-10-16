"""Persistence: workflow runs, quotes, approvals, dedupe keys.

Backed by SQLite locally and PostgreSQL in production (see db.py). Runs and
approvals are persisted so a workflow paused on a manager's approval
survives restarts and deploys, and resumes when the Slack button is clicked.
Every state change that must happen at most once (claiming an inbound
message, deciding an approval) is a single conditional SQL statement, so it
stays correct with many API and worker tasks running at once.
"""

import json
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from .db import Database, connect
from .models import Quote


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, db: Database | str):
        self.db = connect(db) if isinstance(db, str) else db

    def migrate(self) -> list[str]:
        return self.db.migrate()

    def ping(self) -> bool:
        return self.db.ping()

    # --- dedupe -------------------------------------------------------------

    def claim_event(self, key: str) -> bool:
        """True the first time a key is seen; False for every redelivery."""
        return self.db.execute(
            "INSERT INTO processed_events (key, created_at) VALUES (?, ?) ON CONFLICT (key) DO NOTHING",
            (key, now_iso()),
        ) == 1

    # --- runs ---------------------------------------------------------------

    def save_run(self, run: dict[str, Any]) -> None:
        ts = now_iso()
        run["updated_at"] = ts
        run.setdefault("created_at", ts)
        self.db.execute(
            "INSERT INTO runs (id, status, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT (id) DO UPDATE SET status = excluded.status, data = excluded.data, updated_at = excluded.updated_at",
            (run["id"], run["status"], json.dumps(run), run["created_at"], ts),
        )

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        row = self.db.fetchone("SELECT data FROM runs WHERE id = ?", (run_id,))
        return json.loads(row["data"]) if row else None

    def list_runs(self, limit: int = 50) -> list[dict[str, Any]]:
        rows = self.db.fetchall("SELECT data FROM runs ORDER BY created_at DESC, id DESC LIMIT ?", (limit,))
        return [json.loads(r["data"]) for r in rows]

    def stale_runs(self, older_than_seconds: int, limit: int = 100) -> list[dict[str, Any]]:
        """Runs still marked running whose last update is older than the cutoff."""
        cutoff = (datetime.now(timezone.utc) - timedelta(seconds=older_than_seconds)).isoformat(timespec="seconds")
        rows = self.db.fetchall(
            "SELECT data FROM runs WHERE status = 'running' AND updated_at < ? ORDER BY updated_at LIMIT ?",
            (cutoff, limit),
        )
        return [json.loads(r["data"]) for r in rows]

    # --- quotes -------------------------------------------------------------

    def save_quote(self, quote: Quote) -> None:
        self.db.execute(
            "INSERT INTO quotes (id, customer_email, status, data, created_at, seq) VALUES (?, ?, ?, ?, ?, ?) "
            "ON CONFLICT (id) DO UPDATE SET status = excluded.status, data = excluded.data",
            (quote.id, quote.customer_email.lower(), quote.status, quote.model_dump_json(), quote.created_at,
             time.time_ns()),
        )

    def get_quote(self, quote_id: str) -> Quote | None:
        row = self.db.fetchone("SELECT data FROM quotes WHERE id = ?", (quote_id.upper(),))
        return Quote.model_validate_json(row["data"]) if row else None

    def latest_sent_quote(self, customer_email: str) -> Quote | None:
        row = self.db.fetchone(
            "SELECT data FROM quotes WHERE customer_email = ? AND status = 'sent' "
            "ORDER BY created_at DESC, seq DESC LIMIT 1",
            (customer_email.lower(),),
        )
        return Quote.model_validate_json(row["data"]) if row else None

    def list_quotes(self, limit: int = 50) -> list[Quote]:
        rows = self.db.fetchall("SELECT data FROM quotes ORDER BY created_at DESC, seq DESC LIMIT ?", (limit,))
        return [Quote.model_validate_json(r["data"]) for r in rows]

    # --- approvals ----------------------------------------------------------

    def create_approval(self, approval_id: str, run_id: str, data: dict[str, Any]) -> None:
        self.db.execute(
            "INSERT INTO approvals (id, run_id, status, data, created_at) VALUES (?, ?, 'pending', ?, ?)",
            (approval_id, run_id, json.dumps(data), now_iso()),
        )

    def get_approval(self, approval_id: str) -> dict[str, Any] | None:
        row = self.db.fetchone("SELECT * FROM approvals WHERE id = ?", (approval_id,))
        if not row:
            return None
        return {**json.loads(row["data"]), "id": row["id"], "run_id": row["run_id"],
                "status": row["status"], "decided_at": row["decided_at"]}

    def update_approval_data(self, approval_id: str, data: dict[str, Any]) -> None:
        self.db.execute("UPDATE approvals SET data = ? WHERE id = ?", (json.dumps(data), approval_id))

    def decide_approval(self, approval_id: str, decision: str) -> bool:
        """Atomically move pending -> decision. False if already decided."""
        return self.db.execute(
            "UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
            (decision, now_iso(), approval_id),
        ) == 1

    # --- kv -----------------------------------------------------------------

    def get_kv(self, key: str) -> str | None:
        row = self.db.fetchone("SELECT value FROM kv WHERE key = ?", (key,))
        return row["value"] if row else None

    def set_kv(self, key: str, value: str) -> None:
        self.db.execute(
            "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            (key, value),
        )

    def advance_kv_int(self, key: str, value: int) -> None:
        """Set key to value only if it moves forward (e.g. the Gmail history cursor)."""
        current = self.get_kv(key)
        if current is None or int(current) < value:
            self.set_kv(key, str(value))
