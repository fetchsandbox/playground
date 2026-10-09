#!/usr/bin/env python3
"""Exercise the running app against isolated FetchSandbox provider twins.

Usage: .venv/bin/python qa/twin_workflow.py --bindings /tmp/bindings.json \
    --case two_orders_headerless --run-id RUN_ID --output /tmp/evidence.json

Bindings contain stripe/resend objects, each with base_url and api_key. Secrets
remain in memory/the child environment. This harness observes app HTTP responses
and forwarded provider calls; it does not independently verify provider storage.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
import uuid

import httpx


CASES = (
    "baseline", "two_orders_headerless", "duplicate_delivery_headers",
    "repeated_pay", "receipt_retry",
)
ROOT = Path(__file__).resolve().parents[1]
HOP_HEADERS = {
    "connection", "content-length", "host", "keep-alive", "proxy-authenticate",
    "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
    "accept-encoding",
}


def test_address(value: object) -> bool:
    return isinstance(value, str) and bool(re.fullmatch(r"[^\s<>@]+@example\.test", value))


def validate_binding(value: dict, provider: str) -> dict:
    binding = value.get(provider)
    if not isinstance(binding, dict):
        raise ValueError(f"Missing {provider} binding")
    base = binding.get("base_url", "")
    key = binding.get("api_key", "")
    parsed = urlsplit(base)
    if (
        parsed.scheme != "https" or parsed.hostname not in {"fetchsandbox.com", "stage.fetchsandbox.com"}
        or parsed.port not in (None, 443) or parsed.username or parsed.password
        or not parsed.path.startswith("/sandbox/")
        or parsed.path == "/sandbox/" or parsed.query or parsed.fragment
        or ".." in parsed.path or "%" in parsed.path
    ):
        raise ValueError(f"{provider} must use an exact HTTPS fetchsandbox.com/sandbox/... base")
    if not isinstance(key, str) or not key:
        raise ValueError(f"Missing {provider} api_key")
    return {"base_url": base.rstrip("/"), "api_key": key}


def sanitize(value: object, sensitive: list[str]) -> object:
    if isinstance(value, dict):
        return {
            k: ("[redacted]" if any(part in k.lower() for part in
                ("client_secret", "api_key", "authorization", "webhook_secret"))
                else sanitize(v, sensitive))
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [sanitize(item, sensitive) for item in value]
    if isinstance(value, str):
        for item in sensitive:
            if item:
                value = value.replace(item, "[redacted]")
        return value
    return value


class ProviderProxy:
    """Forward only to the supplied twin; never follow provider redirects."""

    def __init__(self, provider: str, binding: dict, run_id: str | None):
        self.provider = provider
        self.binding = binding
        self.run_id = run_id
        self.calls: list[dict] = []
        self.lock = threading.Lock()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                self.forward()

            def do_POST(self):
                self.forward()

            def do_DELETE(self):
                self.forward()

            def forward(self):
                record = {"provider": owner.provider, "method": self.command,
                          "path": self.path, "status": None, "started_at": time.time()}
                with owner.lock:
                    owner.calls.append(record)
                body = b""
                try:
                    # Reject absolute-form requests and all path traversal. The
                    # destination authority is fixed, independent of Host/path.
                    if (not self.path.startswith("/") or self.path.startswith("//")
                            or ".." in urlsplit(self.path).path
                            or "%2e" in self.path.lower() or "\\" in self.path):
                        raise ValueError("Unsafe request path")
                    length = int(self.headers.get("Content-Length", "0"))
                    if length > 1_000_000:
                        raise ValueError("Oversized provider request")
                    body = self.rfile.read(length)
                    if owner.provider == "resend" and self.command == "POST":
                        payload = json.loads(body)
                        recipients = []
                        for field in ("to", "cc", "bcc"):
                            supplied = payload.get(field, [])
                            recipients.extend(supplied if isinstance(supplied, list) else [supplied])
                        if not recipients or not all(test_address(x) for x in recipients):
                            raise ValueError("Only @example.test recipients are allowed")
                        record["recipients"] = recipients
                    elif owner.provider == "stripe" and body:
                        payload = parse_qs(body.decode())
                        if any(not test_address(x) for x in payload.get("receipt_email", [])):
                            raise ValueError("Only @example.test receipt_email is allowed")
                    headers = {k: v for k, v in self.headers.items()
                               if k.lower() not in HOP_HEADERS
                               and k.lower() not in ("x-flow-run-id", "user-agent")}
                    # Stable forwarding-agent identity avoids CDN filtering of
                    # urllib's generic default while preserving app payloads.
                    headers["User-Agent"] = "stripe-receipts-qa/1.0"
                    if owner.run_id:
                        headers["X-Flow-Run-Id"] = owner.run_id
                    if "Idempotency-Key" in self.headers:
                        record["idempotency_key"] = self.headers["Idempotency-Key"]
                    with httpx.Client(trust_env=False, follow_redirects=False, timeout=30) as client:
                        response = client.request(
                            self.command, owner.binding["base_url"] + self.path,
                            headers=headers, content=body,
                        )
                    record["status"] = response.status_code
                    try:
                        data = response.json()
                        record["response"] = data
                        if owner.provider == "stripe" and isinstance(data, dict):
                            # Preserve useful response validation evidence while
                            # never recording usable payment client secrets.
                            payment_secret = data.get("client_secret")
                            record["payment_secret_present"] = bool(payment_secret)
                            record["payment_secret_type"] = type(payment_secret).__name__
                    except ValueError:
                        record["response"] = response.text[:500]
                    record["upstream_completed_at"] = time.time()
                    try:
                        self.send_response(response.status_code)
                        self.send_header("Content-Type", response.headers.get("content-type", "application/json"))
                        self.send_header("Content-Length", str(len(response.content)))
                        self.end_headers()
                        self.wfile.write(response.content)
                    except (BrokenPipeError, ConnectionResetError):
                        record["app_disconnected_before_response"] = True
                except Exception as exc:
                    record["transport_error"] = f"{type(exc).__name__}: {exc}"
                    message = json.dumps({"error": "Isolated twin forwarding failed"}).encode()
                    try:
                        self.send_response(502)
                        self.send_header("Content-Type", "application/json")
                        self.send_header("Content-Length", str(len(message)))
                        self.end_headers()
                        self.wfile.write(message)
                    except (BrokenPipeError, ConnectionResetError):
                        record["app_disconnected_before_response"] = True
                finally:
                    record["completed_at"] = time.time()
                    record["duration_seconds"] = record["completed_at"] - record["started_at"]

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def base_url(self):
        return f"http://127.0.0.1:{self.server.server_port}"

    def start(self):
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        # An app-side timeout can precede the twin's held response. Preserve
        # that upstream outcome even after all app HTTP assertions finish.
        deadline = time.monotonic() + 35
        while any("completed_at" not in call for call in self.calls) and time.monotonic() < deadline:
            time.sleep(0.05)


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class Workflow:
    def __init__(self, client: httpx.Client, secret: str, receipt_attempts: int, retry_delay: float):
        self.client, self.secret = client, secret
        self.receipt_attempts, self.retry_delay = receipt_attempts, retry_delay
        self.steps: list[dict] = []
        self.checks: list[dict] = []
        self.order_ids: list[str] = []

    def call(self, name: str, method: str, path: str, **kwargs) -> dict:
        started_at = time.time()
        response = self.client.request(method, path, **kwargs)
        try:
            body = response.json()
        except ValueError:
            body = {"text": response.text[:1000]}
        result = {"name": name, "method": method, "path": path,
                  "status": response.status_code, "body": body,
                  "started_at": started_at, "completed_at": time.time()}
        result["duration_seconds"] = result["completed_at"] - started_at
        self.steps.append(result)
        return result

    def check(self, name: str, passed: bool, observed: object):
        self.checks.append({"name": name, "passed": bool(passed), "observed": observed})

    def new_order(self, suffix: str) -> tuple[dict, dict]:
        result = self.call(f"create_{suffix}", "POST", "/orders", json={
            "sku": "qa-test-item", "quantity": 1,
            "customer_email": f"qa-{suffix}-{uuid.uuid4().hex[:8]}@example.test",
        })
        self.check(f"{suffix}: order creation", result["status"] == 200, result["status"])
        order = result["body"]
        if result["status"] != 200 or "id" not in order:
            raise RuntimeError("Order creation failed; dependent steps cannot run")
        self.order_ids.append(order["id"])
        payment = self.call(f"pay_{suffix}", "POST", f"/orders/{order['id']}/pay")
        self.check(f"{suffix}: payment intent creation", payment["status"] == 200, payment["status"])
        if payment["status"] != 200 or "payment_intent_id" not in payment["body"]:
            raise RuntimeError("Payment creation failed; dependent steps cannot run")
        return order, payment["body"]

    def event(self, order: dict, payment: dict) -> dict:
        return {
            "id": "evt_qa_" + uuid.uuid4().hex,
            "object": "event", "type": "payment_intent.succeeded",
            "created": int(time.time()), "livemode": False,
            "data": {"object": {
                "id": payment["payment_intent_id"], "object": "payment_intent",
                "status": "succeeded", "amount": order["amount_cents"],
                "amount_received": order["amount_cents"], "currency": "usd",
                "livemode": False, "metadata": {"order_id": order["id"]},
            }},
        }

    def deliver(self, name: str, event: dict, delivery: str | None = None) -> dict:
        body = json.dumps(event, separators=(",", ":")).encode()
        timestamp = str(int(time.time()))
        signature = hmac.new(self.secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()
        headers = {"Content-Type": "application/json", "Stripe-Signature": f"t={timestamp},v1={signature}"}
        if delivery is not None:
            headers["stripe-webhook-id"] = delivery
        return self.call(name, "POST", "/stripe-webhook", content=body, headers=headers)

    def inspect(self, order: dict, name: str) -> dict:
        result = self.call(name, "GET", f"/orders/{order['id']}")
        self.check(f"{name}: readable order", result["status"] == 200, result["status"])
        return result["body"]

    def paid_once(self, order: dict, name: str):
        value = self.inspect(order, name)
        self.check(f"{name}: paid", value.get("status") == "paid", value.get("status"))
        ids = value.get("receipt_ids", [])
        self.check(f"{name}: exactly one recorded receipt", len(ids) == 1, {"count": len(ids), "ids": ids})

    def run(self, case: str):
        if case == "two_orders_headerless":
            for suffix in ("first", "second"):
                order, payment = self.new_order(suffix)
                result = self.deliver(f"webhook_{suffix}", self.event(order, payment))
                self.check(f"{suffix}: webhook acknowledged", result["status"] == 200, result["status"])
                self.paid_once(order, f"final_{suffix}")
            return
        order, payment = self.new_order("main")
        event = self.event(order, payment)
        if case == "repeated_pay":
            second = self.call("pay_again", "POST", f"/orders/{order['id']}/pay")
            self.check("repeated pay returns same intent", second["status"] == 200
                       and second["body"].get("payment_intent_id") == payment["payment_intent_id"],
                       {"status": second["status"], "first": payment["payment_intent_id"],
                        "second": second["body"].get("payment_intent_id")})
        if case == "duplicate_delivery_headers":
            for number in (1, 2):
                result = self.deliver(f"delivery_{number}", event, f"delivery_qa_{number}_{uuid.uuid4().hex}")
                self.check(f"delivery {number}: acknowledged", result["status"] == 200, result["status"])
        elif case == "receipt_retry":
            result = self.deliver("receipt_attempt_1", event)
            self.check("injected receipt failure is retryable", result["status"] >= 500, result["status"])
            self.inspect(order, "after_first_receipt_attempt")
            for number in range(2, self.receipt_attempts + 1):
                time.sleep(self.retry_delay)
                result = self.deliver(f"receipt_attempt_{number}", event)
                value = self.inspect(order, f"after_receipt_attempt_{number}")
                if result["status"] == 200 and len(value.get("receipt_ids", [])) == 1:
                    break
            self.check("receipt retry acknowledged", result["status"] == 200, result["status"])
        else:
            result = self.deliver("webhook", event)
            self.check("webhook acknowledged", result["status"] == 200, result["status"])
        self.paid_once(order, "final")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bindings", required=True, type=Path)
    parser.add_argument("--case", choices=CASES, default="baseline")
    parser.add_argument("--run-id")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--receipt-attempts", type=int, default=3)
    parser.add_argument("--retry-delay", type=float, default=0.3)
    args = parser.parse_args()
    if args.receipt_attempts < 2 or args.retry_delay < 0:
        parser.error("--receipt-attempts must be >= 2 and --retry-delay must be >= 0")
    raw = json.loads(args.bindings.read_text())
    bindings = {provider: validate_binding(raw, provider) for provider in ("stripe", "resend")}
    secret = "whsec_qa_" + secrets.token_hex(24)
    sensitive = [secret, *(b["api_key"] for b in bindings.values())]
    proxies = {name: ProviderProxy(name, binding, args.run_id) for name, binding in bindings.items()}
    process = None
    workflow = None
    evidence = {
        "case": args.case, "run_id": args.run_id,
        "app_sha256": hashlib.sha256((ROOT / "main.py").read_bytes()).hexdigest(),
        "execution": "real uvicorn subprocess; app HTTP endpoints; SDK/urllib provider traffic via allowlisted forwarding proxies",
        "forwarding_transport": {"user_agent": "stripe-receipts-qa/1.0",
                                 "allowed_destination_host": "fetchsandbox.com",
                                 "flow_run_id_header": bool(args.run_id)},
        "unverified": ["Independent provider-side stored resource counts; correlate this output with FetchSandbox traces.",
                       "Webhook events are signed and injected by QA; Stripe confirmation and provider webhook delivery are not exercised.",
                       "Real Stripe payments and real email delivery are intentionally untested."],
    }
    with tempfile.TemporaryFile(mode="w+") as logs:
        try:
            for proxy in proxies.values():
                proxy.start()
            port = free_port()
            env = os.environ.copy()
            env.update({
                "STRIPE_API_KEY": bindings["stripe"]["api_key"],
                "STRIPE_API_BASE": proxies["stripe"].base_url,
                "STRIPE_WEBHOOK_SECRET": secret,
                "RESEND_API_KEY": bindings["resend"]["api_key"],
                "RESEND_API_BASE": proxies["resend"].base_url,
                "RESEND_FROM": "receipts@example.test", "PYTHONUNBUFFERED": "1",
            })
            process = subprocess.Popen(
                [sys.executable, "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", str(port)],
                cwd=ROOT, env=env, stdout=logs, stderr=subprocess.STDOUT,
            )
            with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=90, trust_env=False,
                              limits=httpx.Limits(max_keepalive_connections=0)) as client:
                deadline = time.monotonic() + 15
                while True:
                    if process.poll() is not None:
                        raise RuntimeError(f"App exited during startup with status {process.returncode}")
                    try:
                        if client.get("/openapi.json").status_code == 200:
                            break
                    except httpx.TransportError:
                        pass
                    if time.monotonic() > deadline:
                        raise RuntimeError("App did not become ready within 15 seconds")
                    time.sleep(0.1)
                workflow = Workflow(client, secret, args.receipt_attempts, args.retry_delay)
                workflow.run(args.case)
        except Exception as exc:
            evidence["execution_error"] = f"{type(exc).__name__}: {exc}"
        finally:
            if process is not None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            for proxy in proxies.values():
                proxy.close()
            logs.seek(0)
            log_text = logs.read()
            if "execution_error" in evidence:
                evidence["app_log_tail"] = log_text[-5000:]
    evidence["steps"] = workflow.steps if workflow else []
    evidence["checks"] = workflow.checks if workflow else []
    evidence["provider_calls"] = {name: proxy.calls for name, proxy in proxies.items()}
    evidence["passed"] = [item["name"] for item in evidence["checks"] if item["passed"]]
    evidence["failed"] = [item["name"] for item in evidence["checks"] if not item["passed"]]
    evidence["result"] = "passed" if not evidence["failed"] and "execution_error" not in evidence else "failed"
    output = json.dumps(sanitize(evidence, sensitive), indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output + "\n")
    print(output)
    return 0 if evidence["result"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
