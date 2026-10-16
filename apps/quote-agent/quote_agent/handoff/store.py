"""Persistence for handoff runs, their steps, and the agent action log.

Shares the quote agent's database (SQLite locally, PostgreSQL in AWS). Every
state change that must happen at most once is one conditional statement:
creating the run for a quote, claiming a step, moving a step out of a state.
"""

import json
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from ..db import Database
from ..store import now_iso


class HandoffStore:
    def __init__(self, db: Database):
        self.db = db

    # --- runs ---------------------------------------------------------------

    def create_run(self, run: dict[str, Any], steps: list[dict[str, Any]]) -> bool:
        """Insert the run and its steps. False if the quote already has a run."""
        ts = now_iso()
        inserted = self.db.execute(
            "INSERT INTO handoff_runs (id, quote_id, status, paused, data, created_at, updated_at) "
            "VALUES (?, ?, ?, 0, ?, ?, ?) ON CONFLICT (quote_id) DO NOTHING",
            (run["id"], run["quote_id"], run["status"], json.dumps(run), ts, ts),
        ) == 1
        if not inserted:
            return False
        for seq, step in enumerate(steps):
            self.db.execute(
                "INSERT INTO handoff_steps (run_id, name, seq, agent, status, attempts, data, updated_at) "
                "VALUES (?, ?, ?, ?, 'pending', 0, '{}', ?)",
                (run["id"], step["name"], seq, step["agent"], ts),
            )
        return True

    def _hydrate(self, row: dict[str, Any] | None) -> dict[str, Any] | None:
        if not row:
            return None
        run = json.loads(row["data"])
        run.update(status=row["status"], paused=bool(row["paused"]), created_at=row["created_at"],
                   updated_at=row["updated_at"])
        run["steps"] = self.get_steps(run["id"])
        return run

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        return self._hydrate(self.db.fetchone("SELECT * FROM handoff_runs WHERE id = ?", (run_id,)))

    def get_run_by_quote(self, quote_id: str) -> dict[str, Any] | None:
        return self._hydrate(self.db.fetchone("SELECT * FROM handoff_runs WHERE quote_id = ?", (quote_id,)))

    def list_runs(self, limit: int = 50) -> list[dict[str, Any]]:
        rows = self.db.fetchall("SELECT * FROM handoff_runs ORDER BY created_at DESC, id DESC LIMIT ?", (limit,))
        return [self._hydrate(r) for r in rows]

    def set_run_status(self, run_id: str, status: str, *, error: str | None = None) -> None:
        row = self.db.fetchone("SELECT data FROM handoff_runs WHERE id = ?", (run_id,))
        data = json.loads(row["data"])
        data["status"] = status
        if error is not None:
            data["error"] = error
        elif status in {"running", "completed"}:
            data.pop("error", None)
        self.db.execute("UPDATE handoff_runs SET status = ?, data = ?, updated_at = ? WHERE id = ?",
                        (status, json.dumps(data), now_iso(), run_id))

    def set_paused(self, run_id: str, paused: bool) -> None:
        self.db.execute("UPDATE handoff_runs SET paused = ?, updated_at = ? WHERE id = ?",
                        (1 if paused else 0, now_iso(), run_id))

    # --- steps --------------------------------------------------------------

    def get_steps(self, run_id: str) -> list[dict[str, Any]]:
        rows = self.db.fetchall("SELECT * FROM handoff_steps WHERE run_id = ? ORDER BY seq", (run_id,))
        return [{**json.loads(r["data"]), "name": r["name"], "seq": r["seq"], "agent": r["agent"],
                 "status": r["status"], "attempts": r["attempts"], "updated_at": r["updated_at"]} for r in rows]

    def claim_step(self, run_id: str, name: str, from_statuses: tuple[str, ...]) -> bool:
        """Atomically move a step into 'running'. False if another worker got there first."""
        marks = ", ".join("?" for _ in from_statuses)
        return self.db.execute(
            f"UPDATE handoff_steps SET status = 'running', attempts = attempts + 1, updated_at = ? "
            f"WHERE run_id = ? AND name = ? AND status IN ({marks})",
            (now_iso(), run_id, name, *from_statuses),
        ) == 1

    def move_step(self, run_id: str, name: str, from_status: str, to_status: str,
                  data: dict[str, Any] | None = None) -> bool:
        """Conditionally change a step's state, merging `data` into what it already holds."""
        row = self.db.fetchone("SELECT data FROM handoff_steps WHERE run_id = ? AND name = ?", (run_id, name))
        merged = {**json.loads(row["data"]), **(data or {})}
        return self.db.execute(
            "UPDATE handoff_steps SET status = ?, data = ?, updated_at = ? WHERE run_id = ? AND name = ? AND status = ?",
            (to_status, json.dumps(merged), now_iso(), run_id, name, from_status),
        ) == 1

    def stale_running_steps(self, older_than_seconds: int) -> list[dict[str, Any]]:
        cutoff = (datetime.now(timezone.utc) - timedelta(seconds=older_than_seconds)).isoformat(timespec="seconds")
        return self.db.fetchall(
            "SELECT run_id, name, agent FROM handoff_steps WHERE status = 'running' AND updated_at < ?", (cutoff,))

    def running_steps_for_agent(self, agent: str) -> list[dict[str, Any]]:
        return self.db.fetchall("SELECT run_id, name FROM handoff_steps WHERE status = 'running' AND agent = ?", (agent,))

    # --- action log (append-only) -------------------------------------------

    def append_action(self, *, agent: str, action: str, outcome: str, payload_hash: str,
                      detail: dict[str, Any] | None = None, run_id: str | None = None,
                      step: str | None = None) -> dict[str, Any]:
        entry = {"id": f"ACT-{uuid.uuid4().hex[:12].upper()}", "run_id": run_id, "step": step, "agent": agent,
                 "action": action, "outcome": outcome, "payload_hash": payload_hash, "detail": detail or {},
                 "created_at": now_iso()}
        self.db.execute(
            "INSERT INTO agent_actions (id, run_id, step, agent, action, outcome, payload_hash, detail, created_at, seq) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (entry["id"], run_id, step, agent, action, outcome, payload_hash, json.dumps(entry["detail"]),
             entry["created_at"], time.time_ns()),
        )
        return entry

    def list_actions(self, run_id: str | None = None, limit: int = 500) -> list[dict[str, Any]]:
        if run_id:
            rows = self.db.fetchall("SELECT * FROM agent_actions WHERE run_id = ? ORDER BY seq LIMIT ?", (run_id, limit))
        else:
            rows = self.db.fetchall("SELECT * FROM agent_actions ORDER BY seq DESC LIMIT ?", (limit,))
        return [{**{k: r[k] for k in ("id", "run_id", "step", "agent", "action", "outcome", "payload_hash",
                                      "created_at")}, "detail": json.loads(r["detail"])} for r in rows]
