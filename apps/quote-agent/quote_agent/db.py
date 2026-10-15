"""Database access for SQLite (local dev, tests) and PostgreSQL (production).

Both run the same SQL: statements are written with `?` placeholders and the
portable `INSERT ... ON CONFLICT` form, and the Postgres backend rewrites the
placeholders. Schema changes live in quote_agent/migrations/NNNN_*.sql and are
applied in order by `migrate()`, recorded in schema_migrations.
"""

import logging
import sqlite3
import threading
from contextlib import contextmanager
from importlib import resources
from typing import Any, Iterator

log = logging.getLogger(__name__)


class Database:
    dialect = "base"

    def execute(self, sql: str, args: tuple = ()) -> int:
        """Run a write; return the affected row count."""
        raise NotImplementedError

    def fetchone(self, sql: str, args: tuple = ()) -> dict[str, Any] | None:
        rows = self.fetchall(sql, args)
        return rows[0] if rows else None

    def fetchall(self, sql: str, args: tuple = ()) -> list[dict[str, Any]]:
        raise NotImplementedError

    def executescript(self, sql: str) -> None:
        raise NotImplementedError

    def ping(self) -> bool:
        try:
            return self.fetchone("SELECT 1 AS ok") is not None
        except Exception:  # noqa: BLE001 — readiness must never raise
            log.exception("database ping failed")
            return False

    def close(self) -> None:
        pass

    # --- migrations ---------------------------------------------------------

    def migrate(self) -> list[str]:
        """Apply pending migrations; return the names applied."""
        self.executescript("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)")
        done = {r["name"] for r in self.fetchall("SELECT name FROM schema_migrations")}
        files = sorted(f for f in resources.files("quote_agent.migrations").iterdir() if f.name.endswith(".sql"))
        applied = []
        for f in files:
            if f.name in done:
                continue
            with self._migration_lock():
                if self.fetchone("SELECT name FROM schema_migrations WHERE name = ?", (f.name,)):
                    continue  # another task applied it while we waited
                self.executescript(f.read_text())
                self.execute("INSERT INTO schema_migrations (name, applied_at) VALUES (?, CURRENT_TIMESTAMP)", (f.name,))
            log.info("applied migration %s", f.name)
            applied.append(f.name)
        return applied

    @contextmanager
    def _migration_lock(self) -> Iterator[None]:
        yield


class SQLiteDatabase(Database):
    dialect = "sqlite"

    def __init__(self, path: str):
        self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._lock = threading.Lock()

    def execute(self, sql: str, args: tuple = ()) -> int:
        with self._lock:
            return self._conn.execute(sql, args).rowcount

    def fetchall(self, sql: str, args: tuple = ()) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(r) for r in self._conn.execute(sql, args).fetchall()]

    def executescript(self, sql: str) -> None:
        with self._lock:
            self._conn.executescript(sql)

    def close(self) -> None:
        self._conn.close()


class PostgresDatabase(Database):
    dialect = "postgres"
    _LOCK_ID = 7_031_977  # pg_advisory_lock key: one migrator at a time

    def __init__(self, dsn: str, *, min_size: int = 1, max_size: int = 10):
        from psycopg.rows import dict_row
        from psycopg_pool import ConnectionPool

        self._pool = ConnectionPool(dsn, min_size=min_size, max_size=max_size, open=True,
                                    kwargs={"autocommit": True, "row_factory": dict_row})

    @staticmethod
    def _sql(sql: str) -> str:
        # Our statements never contain a literal '?' or '%', so this is a safe rewrite.
        return sql.replace("%", "%%").replace("?", "%s")

    def execute(self, sql: str, args: tuple = ()) -> int:
        with self._pool.connection() as conn:
            return conn.execute(self._sql(sql), args).rowcount

    def fetchall(self, sql: str, args: tuple = ()) -> list[dict[str, Any]]:
        with self._pool.connection() as conn:
            return list(conn.execute(self._sql(sql), args).fetchall())

    def executescript(self, sql: str) -> None:
        with self._pool.connection() as conn:
            conn.execute(sql)

    def close(self) -> None:
        self._pool.close()

    @contextmanager
    def _migration_lock(self) -> Iterator[None]:
        with self._pool.connection() as conn:
            conn.execute("SELECT pg_advisory_lock(%s)", (self._LOCK_ID,))
            try:
                yield
            finally:
                conn.execute("SELECT pg_advisory_unlock(%s)", (self._LOCK_ID,))


def connect(url: str) -> Database:
    """`postgresql://...` -> Postgres; `sqlite:///path` or a bare path -> SQLite."""
    if url.startswith(("postgres://", "postgresql://")):
        return PostgresDatabase(url)
    return SQLiteDatabase(url.removeprefix("sqlite:///"))
