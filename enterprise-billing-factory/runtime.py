"""Local synthetic billing API, payment service and durable queue worker.

Run separate uvicorn processes for runtime:billing and runtime:payments.
This reference does not call any real payment provider.
"""
from __future__ import annotations
import argparse
import hashlib
import hmac
import json
import os
import re
import uuid
from contextlib import contextmanager

import httpx
import psycopg
from psycopg.rows import dict_row
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

SCHEMA = os.environ.get("DEMO_SCHEMA", "")
if not re.fullmatch(r"vf_[0-9a-f]{12}", SCHEMA):
    raise RuntimeError("DEMO_SCHEMA must be an isolated vf_<12 hex> namespace")


@contextmanager
def db():
    with psycopg.connect(os.environ["DEMO_DATABASE_URL"], row_factory=dict_row,
                         options=f"-c search_path={SCHEMA}") as connection:
        yield connection


def initialize():
    with db() as c:
        c.execute(f'CREATE SCHEMA IF NOT EXISTS "{SCHEMA}"')
        c.execute("""CREATE TABLE IF NOT EXISTS invoices (
          tenant text, id text, amount bigint CHECK(amount>0), currency text,
          status text NOT NULL DEFAULT 'open', PRIMARY KEY(tenant,id))""")
        c.execute("""CREATE TABLE IF NOT EXISTS jobs (
          id text PRIMARY KEY, tenant text, invoice text, state text DEFAULT 'queued',
          attempts int DEFAULT 0, lease_until timestamptz,
          UNIQUE(tenant,invoice))""")
        c.execute("""CREATE TABLE IF NOT EXISTS payments (
          id text PRIMARY KEY, tenant text, invoice text, operation_key text,
          amount bigint CHECK(amount>0), currency text,
          UNIQUE(tenant,operation_key))""")
        c.execute("""CREATE TABLE IF NOT EXISTS lifecycle (
          id bigserial PRIMARY KEY, job text, kind text, at timestamptz DEFAULT now())""")


def auth(value, variable):
    expected = os.environ.get(variable)
    if not expected or not value or not hmac.compare_digest(value, f"Bearer {expected}"):
        raise HTTPException(401, "unauthorized")


def tenant_auth(value):
    for token, tenant in json.loads(os.environ.get("DEMO_TENANT_TOKENS", "{}")).items():
        if value and hmac.compare_digest(value, "Bearer " + token):
            return tenant
    raise HTTPException(401, "unauthorized")


class Invoice(BaseModel):
    id: str = Field(pattern=r"^INV-[0-9]{4,10}$")
    amount: int = Field(gt=0, le=100000000)
    currency: str = Field(pattern=r"^(USD|EUR)$")


class Payment(Invoice):
    tenant: str = Field(pattern=r"^tenant_[a-z]+$")
    operation_key: str = Field(min_length=8, max_length=128)


billing = FastAPI(title="Synthetic billing API", docs_url=None, redoc_url=None)
payments = FastAPI(title="Synthetic payment service", docs_url=None, redoc_url=None)


@billing.post("/invoices", status_code=201)
def invoice(body: Invoice, authorization: str | None = Header(default=None)):
    tenant = tenant_auth(authorization)
    with db() as c:
        row = c.execute("SELECT * FROM invoices WHERE tenant=%s AND id=%s", (tenant, body.id)).fetchone()
        if row and (row["amount"] != body.amount or row["currency"] != body.currency):
            raise HTTPException(409, "invoice conflicts with existing values")
        c.execute("INSERT INTO invoices(tenant,id,amount,currency) VALUES(%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                  (tenant, body.id, body.amount, body.currency))
    return {"invoice": body.id}


@billing.post("/invoices/{invoice_id}/collect", status_code=202)
def collect(invoice_id: str, authorization: str | None = Header(default=None)):
    tenant = tenant_auth(authorization)
    with db() as c:
        if not c.execute("SELECT id FROM invoices WHERE tenant=%s AND id=%s", (tenant, invoice_id)).fetchone():
            raise HTTPException(404, "invoice not found")
        c.execute("INSERT INTO jobs(id,tenant,invoice) VALUES(%s,%s,%s) ON CONFLICT DO NOTHING",
                  (str(uuid.uuid4()), tenant, invoice_id))
        row = c.execute("SELECT id,state FROM jobs WHERE tenant=%s AND invoice=%s", (tenant, invoice_id)).fetchone()
    return {"job_id": row["id"], "state": row["state"]}


@billing.get("/invoices/{invoice_id}")
def read_invoice(invoice_id: str, authorization: str | None = Header(default=None)):
    tenant = tenant_auth(authorization)
    with db() as c:
        row = c.execute("SELECT id,amount,currency,status FROM invoices WHERE tenant=%s AND id=%s", (tenant, invoice_id)).fetchone()
    if not row: raise HTTPException(404, "invoice not found")
    return row


@payments.post("/payments")
def pay(body: Payment, authorization: str | None = Header(default=None)):
    auth(authorization, "DEMO_WORKER_TOKEN")
    with db() as c:
        c.execute("""INSERT INTO payments(id,tenant,invoice,operation_key,amount,currency)
          VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT(tenant,operation_key) DO NOTHING""",
          (str(uuid.uuid4()), body.tenant, body.id, body.operation_key, body.amount, body.currency))
        row = c.execute("SELECT * FROM payments WHERE tenant=%s AND operation_key=%s", (body.tenant, body.operation_key)).fetchone()
        if any(row[k] != v for k, v in {"invoice": body.id, "amount": body.amount, "currency": body.currency}.items()):
            raise HTTPException(409, "payment identity conflicts with original values")
    return {"payment_id": row["id"], "status": "succeeded"}


def work(strategy="invoice", crash_after_payment=False):
    with db() as c:
        job = c.execute("""SELECT * FROM jobs WHERE state='queued' OR
          (state='processing' AND lease_until < now()) ORDER BY id
          FOR UPDATE SKIP LOCKED LIMIT 1""").fetchone()
        if not job: return False
        c.execute("UPDATE jobs SET state='processing',attempts=attempts+1,lease_until=now()+interval '1 second' WHERE id=%s", (job["id"],))
        inv = c.execute("SELECT * FROM invoices WHERE tenant=%s AND id=%s", (job["tenant"], job["invoice"])).fetchone()
        c.execute("INSERT INTO lifecycle(job,kind) VALUES(%s,'worker_claimed')", (job["id"],))
    identity = f"{job['tenant']}:{job['invoice']}:1"
    if strategy == "delivery": identity += f":attempt-{job['attempts'] + 1}"
    key = hashlib.sha256(identity.encode()).hexdigest()
    response = httpx.post(os.environ["DEMO_PAYMENT_URL"] + "/payments", json={
        "id": inv["id"], "amount": inv["amount"], "currency": inv["currency"], "tenant": job["tenant"], "operation_key": key},
        headers={"Authorization": "Bearer " + os.environ["DEMO_WORKER_TOKEN"]}, timeout=10)
    response.raise_for_status()
    if crash_after_payment:
        # Deliberate maintainer failure injection. The process actually exits.
        os._exit(75)
    with db() as c:
        c.execute("UPDATE invoices SET status='paid' WHERE tenant=%s AND id=%s", (job["tenant"], inv["id"]))
        c.execute("UPDATE jobs SET state='done',lease_until=NULL WHERE id=%s", (job["id"],))
        c.execute("INSERT INTO lifecycle(job,kind) VALUES(%s,'worker_completed')", (job["id"],))
    return True


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("action", choices=["init", "work"])
    p.add_argument("--strategy", choices=["invoice", "delivery"], default="invoice")
    p.add_argument("--crash-after-payment", action="store_true")
    a = p.parse_args()
    if a.action == "init": initialize()
    else: print(json.dumps({"processed": work(a.strategy, a.crash_after_payment)}))
