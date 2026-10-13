"""Durable record of what has been done for each Gmail message.

Each step (Slack post, Calendar event) is saved as soon as it succeeds, so a
retry after a partial failure only redoes the step that is still missing.
SQLite locally, DynamoDB on AWS.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from typing import Any, Protocol

Record = dict[str, Any]


class Store(Protocol):
    def get(self, message_id: str) -> Record | None: ...
    def put(self, record: Record) -> None: ...
    def all(self, limit: int = 100) -> list[Record]: ...


class SqliteStore:
    def __init__(self, path: str):
        self._lock = threading.Lock()
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS processed ("
            " message_id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, data TEXT NOT NULL)"
        )
        self._db.commit()

    def get(self, message_id: str) -> Record | None:
        with self._lock:
            row = self._db.execute("SELECT data FROM processed WHERE message_id = ?", (message_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def put(self, record: Record) -> None:
        with self._lock:
            self._db.execute(
                "INSERT INTO processed (message_id, updated_at, data) VALUES (?, ?, ?)"
                " ON CONFLICT(message_id) DO UPDATE SET updated_at = excluded.updated_at, data = excluded.data",
                (record["message_id"], record["updated_at"], json.dumps(record)),
            )
            self._db.commit()

    def all(self, limit: int = 100) -> list[Record]:
        with self._lock:
            rows = self._db.execute(
                "SELECT data FROM processed ORDER BY updated_at DESC LIMIT ?", (limit,)
            ).fetchall()
        return [json.loads(r[0]) for r in rows]


class DynamoStore:
    def __init__(self, table_name: str, resource=None):
        import boto3  # available in the Lambda runtime

        self._table = (resource or boto3.resource("dynamodb")).Table(table_name)

    def get(self, message_id: str) -> Record | None:
        item = self._table.get_item(Key={"message_id": message_id}, ConsistentRead=True).get("Item")
        return json.loads(item["data"]) if item else None

    def put(self, record: Record) -> None:
        self._table.put_item(Item={
            "message_id": record["message_id"],
            "updated_at": record["updated_at"],
            "status": record["status"],
            "data": json.dumps(record),
        })

    def all(self, limit: int = 100) -> list[Record]:
        items = self._table.scan(Limit=limit).get("Items", [])
        records = [json.loads(i["data"]) for i in items]
        return sorted(records, key=lambda r: r["updated_at"], reverse=True)


def make_store(backend: str, sqlite_path: str, dynamodb_table: str) -> Store:
    if backend == "dynamodb":
        return DynamoStore(dynamodb_table)
    if backend == "sqlite":
        return SqliteStore(sqlite_path)
    raise ValueError(f"unknown STATE_BACKEND {backend!r}")
