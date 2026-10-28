"""Maintainer integration checks, not a FetchSandbox/native-agent receipt.

Runs only explicitly opted-in, exclusively against a newly created local
PostgreSQL container and loopback application processes. Never reads AWS secrets.
"""
import concurrent.futures
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

import httpx
import psycopg

ROOT = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipUnless(os.environ.get("RUN_LOCAL_BILLING") == "1", "explicit local Docker opt-in required")
class LocalBillingRuntime(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.container = "vf-billing-test-" + uuid.uuid4().hex[:10]
        password = secrets.token_hex(20)
        subprocess.run(["docker", "run", "-d", "--name", cls.container, "-p", "127.0.0.1::5432",
                        "-e", "POSTGRES_PASSWORD=" + password, "-e", "POSTGRES_DB=vf",
                        "postgres:16-alpine"], check=True, capture_output=True)
        port = subprocess.check_output(["docker", "port", cls.container, "5432"], text=True).strip().split(":")[-1]
        cls.url = f"postgresql://postgres:{password}@127.0.0.1:{port}/vf"
        cls.observations = []
        for _ in range(100):
            try:
                with psycopg.connect(cls.url): break
            except psycopg.OperationalError: time.sleep(.1)
        else:
            subprocess.run(["docker", "rm", "-fv", cls.container], capture_output=True)
            raise RuntimeError("local test database unavailable")

    @classmethod
    def tearDownClass(cls):
        out = os.environ.get("BILLING_OBSERVATIONS")
        if out:
            Path(out).write_text(json.dumps({"scope": "local maintainer integration checks",
                "native_agent": "not_run", "fetchsandbox_receipt": None, "aws": "not_deployed",
                "observations": cls.observations}, indent=2))
        subprocess.run(["docker", "rm", "-fv", cls.container], capture_output=True, check=True)

    def setUp(self):
        self.schema = "vf_" + uuid.uuid4().hex[:12]
        self.token = secrets.token_hex(20)
        self.other = secrets.token_hex(20)
        self.env = {**os.environ, "DEMO_SCHEMA": self.schema, "DEMO_DATABASE_URL": self.url,
            "DEMO_TENANT_TOKENS": json.dumps({self.token: "tenant_alder", self.other: "tenant_birch"}),
            "DEMO_WORKER_TOKEN": secrets.token_hex(20)}
        self.worker(["init"])
        self.processes = []
        self.logs = []
        self.addCleanup(self.stop_processes)
        self.payment_port, self.billing_port = free_port(), free_port()
        self.env["DEMO_PAYMENT_URL"] = f"http://127.0.0.1:{self.payment_port}"
        for role, port in [("payments", self.payment_port), ("billing", self.billing_port)]:
            log = tempfile.TemporaryFile(); self.logs.append(log)
            proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "runtime:" + role,
                "--host", "127.0.0.1", "--port", str(port)], cwd=ROOT, env=self.env, stdout=log, stderr=log)
            self.processes.append(proc)
            for _ in range(100):
                try:
                    if httpx.get(f"http://127.0.0.1:{port}/openapi.json", timeout=.2).status_code == 200: break
                except httpx.HTTPError: pass
                if proc.poll() is not None:
                    log.seek(0); raise RuntimeError(log.read().decode()[-1500:])
                time.sleep(.1)
            else: raise RuntimeError("test service did not start")
        self.base = f"http://127.0.0.1:{self.billing_port}"
        self.headers = {"Authorization": "Bearer " + self.token}
        data = json.loads((ROOT / "fixtures/signals.json").read_text())["invoices"][0]
        self.body = {"id": data["id"], "amount": data["amount_minor"], "currency": data["currency"]}
        self.assertEqual(httpx.post(self.base + "/invoices", json=self.body, headers=self.headers).status_code, 201)

    def stop_processes(self):
        for p in self.processes:
            if p.poll() is None: p.terminate()
        for p in self.processes:
            try: p.wait(timeout=5)
            except subprocess.TimeoutExpired: p.kill(); p.wait()
        for log in self.logs: log.close()

    def worker(self, args, expected=0):
        p = subprocess.run([sys.executable, "runtime.py", *args], cwd=ROOT, env=self.env,
                           capture_output=True, text=True, timeout=30)
        self.assertEqual(p.returncode, expected, p.stderr)
        return p

    def enqueue(self):
        r = httpx.post(self.base + "/invoices/INV-1042/collect", headers=self.headers)
        self.assertEqual(r.status_code, 202)
        return r.json()

    def payment_count(self):
        # Independent direct PostgreSQL read, not an application success flag.
        with psycopg.connect(self.url, options=f"-c search_path={self.schema}") as c:
            return c.execute("SELECT count(*),coalesce(sum(amount),0) FROM payments").fetchone()

    def test_baseline_and_duplicate_queue_delivery(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            jobs = list(pool.map(lambda _: self.enqueue()["job_id"], range(6)))
        self.assertEqual(len(set(jobs)), 1)
        self.worker(["work"]); self.enqueue(); self.worker(["work"])
        self.assertEqual(self.payment_count(), (1, 12500))
        self.assertEqual(httpx.get(self.base + "/invoices/INV-1042", headers=self.headers).json()["status"], "paid")

    def test_delivery_identity_reproduces_double_charge_after_actual_process_exit(self):
        self.enqueue()
        self.worker(["work", "--strategy", "delivery", "--crash-after-payment"], expected=75)
        self.assertEqual(self.payment_count(), (1, 12500))
        time.sleep(1.1)
        self.worker(["work", "--strategy", "delivery"])
        self.assertEqual(self.payment_count(), (2, 25000))
        self.observations.append({"strategy": "delivery", "scenario": "process_exit_after_payment_before_ack",
            "business_rule_passed": False, "payments": 2, "amount_minor": 25000})

    def test_invoice_identity_preserves_one_charge_after_actual_process_exit(self):
        self.enqueue()
        self.worker(["work", "--strategy", "invoice", "--crash-after-payment"], expected=75)
        self.assertEqual(self.payment_count(), (1, 12500))
        time.sleep(1.1)
        self.worker(["work", "--strategy", "invoice"])
        self.assertEqual(self.payment_count(), (1, 12500))
        self.assertEqual(httpx.get(self.base + "/invoices/INV-1042", headers=self.headers).json()["status"], "paid")
        self.observations.append({"strategy": "invoice", "scenario": "process_exit_after_payment_before_ack",
            "business_rule_passed": True, "payments": 1, "amount_minor": 12500})

    def test_concurrent_workers(self):
        self.enqueue()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(lambda _: self.worker(["work"]), range(2)))
        self.assertEqual(self.payment_count(), (1, 12500))

    def test_tenant_and_anonymous_access(self):
        path = self.base + "/invoices/INV-1042"
        self.assertEqual(httpx.get(path).status_code, 401)
        self.assertEqual(httpx.get(path, headers={"Authorization": "Bearer invalid"}).status_code, 401)
        h = {"Authorization": "Bearer " + self.other}
        self.assertEqual(httpx.get(path, headers=h).status_code, 404)
        self.assertEqual(httpx.post(path + "/collect", headers=h).status_code, 404)
        self.assertEqual(self.payment_count(), (0, 0))

    def test_payment_identity_reuse_with_different_amount_rejected(self):
        h = {"Authorization": "Bearer " + self.env["DEMO_WORKER_TOKEN"]}
        body = {**self.body, "tenant": "tenant_alder", "operation_key": "fixed-operation"}
        url = self.env["DEMO_PAYMENT_URL"] + "/payments"
        self.assertEqual(httpx.post(url, json=body, headers=h).status_code, 200)
        body["amount"] += 1
        self.assertEqual(httpx.post(url, json=body, headers=h).status_code, 409)
        self.assertEqual(self.payment_count(), (1, 12500))


if __name__ == "__main__": unittest.main()
