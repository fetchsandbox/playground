"""Drive the real app against FetchSandbox twins: quote first, then the customer handoff.

FetchSandbox's caller-executed path: the app's own provider clients talk to the
session's twins, and every provider request carries the armed run's
X-Flow-Run-Id (QUOTE_AGENT_PROVIDER_HEADERS). FetchSandbox judges the provider
traffic; this script separately reads back the app's saved state and the
provider records, and prints both as evidence.

    python verification/handoff_fetchsandbox.py seed    <twins.json> <state_dir> <tag>
    python verification/handoff_fetchsandbox.py handoff <twins.json> <state_dir> <tag> ['{"X-Flow-Run-Id": "..."}']
    python verification/handoff_fetchsandbox.py retry|verify|resume <twins.json> <state_dir> <tag> [headers]
    python verification/handoff_fetchsandbox.py readback <twins.json> <state_dir> <tag>   (after `probe`)

`seed` starts the app with no fault headers and creates a sent quote through
the quote agent's normal entry point (POST /dev/inbound). `handoff` restarts
the app on the same database, with the armed run's headers, and starts the
handoff for that quote over the handoff API (POST /handoff/runs) — the same
call an external agent or CRM automation makes. `readback` then reads the
provider records the run claims straight from the twins; run it only after
the probe is evaluated, because its requests carry no run header.

twins.json: {"hubspot": {"base_url", "api_key"}, "stripe": {...}, "resend": {...}, "slack": {...}}
"""

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx

APP_DIR = Path(__file__).resolve().parents[1]
TOKEN = "verify-handoff-token"
SLACK_CHANNEL = "C0BILLING01"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _env(twins: dict, db: Path, headers: dict | None) -> dict:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("HUBSPOT", "STRIPE", "RESEND", "SLACK", "GMAIL"))}
    env.update({
        "ENVIRONMENT": "development", "QUOTE_AGENT_DB": str(db), "CLASSIFIER": "rules", "DEV_ENDPOINTS": "true",
        "HUBSPOT_BASE_URL": twins["hubspot"]["base_url"], "HUBSPOT_ACCESS_TOKEN": twins["hubspot"]["api_key"],
        "HUBSPOT_RECORD_DEALS": "false",  # the HubSpot twin has no Deals API
        "SLACK_BASE_URL": twins["slack"]["base_url"].rstrip("/") + "/api", "SLACK_BOT_TOKEN": twins["slack"]["api_key"],
        "SLACK_MANAGER_CHANNEL": "C0APPROVALS1",
        "STRIPE_BASE_URL": twins["stripe"]["base_url"], "STRIPE_SECRET_KEY": twins["stripe"]["api_key"],
        "RESEND_BASE_URL": twins["resend"]["base_url"], "RESEND_API_KEY": twins["resend"]["api_key"],
        "HANDOFF_FROM_EMAIL": "welcome@northwind.example", "HANDOFF_API_TOKEN": TOKEN,
        "PROVIDER_TIMEOUT_SECONDS": os.environ.get("PROVIDER_TIMEOUT_SECONDS", "15"),
        "QUOTE_AGENT_PROVIDER_HEADERS": json.dumps(headers or {}),
        "ANTHROPIC_API_KEY": "",
    })
    return env


class App:
    def __init__(self, twins: dict, db: Path, headers: dict | None, log: Path):
        self.port = _free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "main:app", "--port", str(self.port), "--log-level", "warning"],
            cwd=APP_DIR, env=_env(twins, db, headers), stdout=log.open("a"), stderr=subprocess.STDOUT)
        for _ in range(100):
            try:
                if httpx.get(f"{self.url}/health", timeout=1).status_code == 200:
                    return
            except httpx.HTTPError:
                time.sleep(0.2)
        raise RuntimeError("app did not start")

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.proc.terminate()
        self.proc.wait(10)


def seed(twins: dict, state: Path, tag: str) -> dict:
    with App(twins, state / "app.db", None, state / "app.log") as app:
        sender = os.environ.get("SEED_EMAIL") or f"{tag}@example.com"  # e.g. bounced@resend.dev
        msg = {"channel": "slack", "external_id": f"{tag}-quote", "sender_email": sender,
               "sender_name": "Dana Scully", "subject": "Pricing", "text": "Hi, can we get a quote for 25 seats of Pro?",
               "reply_ref": {"channel": SLACK_CHANNEL, "ts": f"17{abs(hash(tag)) % 10**8:08d}.000100",
                             "thread_ts": f"17{abs(hash(tag)) % 10**8:08d}.000100", "user": "U0BOB00001"}}
        run = httpx.post(f"{app.url}/dev/inbound", json=msg, timeout=60).json()
    out = {"quote_run_status": run.get("status"), "quote_id": run.get("quote_id"), "error": run.get("error"),
           "quote_steps": [(s["name"], s["status"]) for s in run.get("steps", [])]}
    (state / f"{tag}.seed.json").write_text(json.dumps(out))
    return out


def _provider_readback(twins: dict, run: dict) -> dict:
    """Read the provider records the run claims, straight from the twins (not through the app)."""
    eff = {s["name"]: s.get("effect") or {} for s in run["steps"]}
    out: dict = {}
    with httpx.Client(timeout=20) as h:
        hs, st, rs = twins["hubspot"], twins["stripe"], twins["resend"]
        if eff["crm_lifecycle"].get("contact_id"):
            c = h.get(f"{hs['base_url']}/crm/v3/objects/contacts/{eff['crm_lifecycle']['contact_id']}",
                      params={"properties": "email,lifecyclestage"},
                      headers={"Authorization": f"Bearer {hs['api_key']}"}).json()
            out["hubspot_contact"] = c.get("properties")
        cust = h.get(f"{st['base_url']}/v1/customers", params={"email": run["customer_email"], "limit": 10},
                     headers={"Authorization": f"Bearer {st['api_key']}"}).json().get("data", [])
        out["stripe_customers_for_email"] = len([c for c in cust if c.get("email") == run["customer_email"]])
        invoices = []
        for c in cust:
            for inv in h.get(f"{st['base_url']}/v1/invoices", params={"customer": c["id"], "limit": 100},
                             headers={"Authorization": f"Bearer {st['api_key']}"}).json().get("data", []):
                if (inv.get("metadata") or {}).get("handoff_run") == run["id"]:
                    invoices.append({k: inv.get(k) for k in ("id", "status", "total", "currency", "metadata")})
        out["stripe_invoices_for_run"] = invoices
        if eff["welcome_email"].get("email_id"):
            e = h.get(f"{rs['base_url']}/emails/{eff['welcome_email']['email_id']}",
                      headers={"Authorization": f"Bearer {rs['api_key']}"}).json()
            out["resend_email"] = {k: e.get(k) for k in ("id", "to", "subject", "last_event")}
    return out


def handoff(twins: dict, state: Path, tag: str, headers: dict | None, command: str = "handoff") -> dict:
    seeded = json.loads((state / f"{tag}.seed.json").read_text())
    auth = {"Authorization": f"Bearer {TOKEN}"}
    with App(twins, state / "app.db", headers, state / "app.log") as app:
        if command == "handoff":
            r = httpx.post(f"{app.url}/handoff/runs", json={"quote_id": seeded["quote_id"], "requested_by": "verifier"},
                           headers=auth, timeout=180)
        else:  # retry | verify | resume: act on the run this tag already started
            run_id = json.loads((state / f"{tag}.handoff.json").read_text())["run_id"]
            r = httpx.post(f"{app.url}/handoff/runs/{run_id}/{command}", headers=auth, timeout=180)
        run = r.json()
        if r.status_code != 200:
            return {"http_status": r.status_code, "body": run}
        actions = httpx.get(f"{app.url}/actions", params={"run_id": run["id"]}, headers=auth, timeout=30).json()["actions"]
    out = {
        "run_id": run["id"], "quote_id": run["quote_id"], "status": run["status"], "error": run.get("error"),
        "amount_cents": run["amount_cents"],
        "steps": [{"name": s["name"], "status": s["status"], "attempts": s["attempts"],
                   "resolved_from_uncertain": s.get("resolved_from_uncertain"), "error": s.get("error")}
                  for s in run["steps"]],
        "action_log": [(a["step"], a["action"], a["outcome"]) for a in actions],
    }
    (state / f"{tag}.run.json").write_text(json.dumps(run))
    (state / f"{tag}.handoff.json").write_text(json.dumps(out, indent=1))
    (state / f"{tag}.{command}.json").write_text(json.dumps(out, indent=1))
    return out


def readback(twins: dict, state: Path, tag: str) -> dict:
    """Run only after the probe is evaluated: these reads carry no run header."""
    run = json.loads((state / f"{tag}.run.json").read_text())
    out = _provider_readback(twins, run)
    (state / f"{tag}.readback.json").write_text(json.dumps(out, indent=1))
    return out


if __name__ == "__main__":
    cmd, twins_path, state_dir, tag = sys.argv[1:5]
    twins = json.loads(Path(twins_path).read_text())
    state = Path(state_dir) / tag
    state.mkdir(parents=True, exist_ok=True)
    if cmd == "seed":
        print(json.dumps(seed(twins, state, tag), indent=1))
    elif cmd == "readback":
        print(json.dumps(readback(twins, state, tag), indent=1))
    else:
        print(json.dumps(handoff(twins, state, tag, json.loads(sys.argv[5]) if len(sys.argv) > 5 else None, cmd),
                         indent=1))
