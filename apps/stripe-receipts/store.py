"""Durable demo ledger. SQLite serializes writers across processes, not just threads."""
import json
import os
import sqlite3
from contextlib import contextmanager


@contextmanager
def connection():
    path = os.environ.get("ORDERS_DB_PATH", "orders.sqlite3")
    db = sqlite3.connect(path, timeout=30, isolation_level=None)
    db.execute("PRAGMA busy_timeout=30000")
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=FULL")
    db.execute("CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, value TEXT NOT NULL)")
    db.execute("CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, order_id TEXT, type TEXT NOT NULL)")
    try:
        yield db
    finally:
        db.close()


@contextmanager
def transaction():
    with connection() as db:
        try:
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise


@contextmanager
def read():
    # WAL readers can see the last committed payment while a send is pending.
    # A read must not wait for the network request's write transaction.
    with connection() as db:
        yield db


def get(db, order_id):
    row = db.execute("SELECT value FROM orders WHERE id=?", (order_id,)).fetchone()
    return json.loads(row[0]) if row else None


def put(db, order):
    db.execute("INSERT INTO orders(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
               (order["id"], json.dumps(order, sort_keys=True)))


def all_orders(db):
    return [json.loads(row[0]) for row in db.execute("SELECT value FROM orders ORDER BY id")]
