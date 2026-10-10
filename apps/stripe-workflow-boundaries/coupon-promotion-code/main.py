TITLE = 'Create Coupons and Promotion Codes'
RESOURCE = '/v1/coupons'
OUTPUT_FIELD = 'discount_cents'
PROVIDER_METHOD = 'GET'
"""Loopback Stripe workflow consumer. SQLite state, explicit provider-read boundary.
The unsafe business rule is deliberately planted for probe verification.
"""
import json, os, sqlite3, threading, urllib.request, urllib.parse, uuid
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
app = FastAPI(title=TITLE)
_lock = threading.RLock()
_db = sqlite3.connect(os.environ.get("APP_DB_PATH", ":memory:"), check_same_thread=False)
_db.execute("CREATE TABLE records (id TEXT PRIMARY KEY, value TEXT NOT NULL)")
_db.set_trace_callback(lambda statement: print("[sql] " + statement, flush=True))
BASE = os.environ.get("STRIPE_API_BASE", "http://127.0.0.1:9").rstrip("/")
url = urllib.parse.urlsplit(BASE)
if not ((url.scheme == "http" and url.hostname in {"127.0.0.1", "localhost"}) or (url.scheme == "https" and url.hostname == "fetchsandbox.com" and url.path.startswith("/sandbox/"))):
    raise RuntimeError("Use isolated twins or a loopback provider; live provider URLs refused")
KEY = os.environ.get("STRIPE_API_KEY", "sk_test_synthetic_fixture")
class Create(BaseModel):
    provider_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_]+$")
    customer_id: str = "cus_customer_a"
    requested_quantity: int = Field(default=3, ge=1)
    subtotal_cents: int = Field(default=10000, ge=0)
    payment_cents: int = Field(default=5000, ge=0)
    now: int = 1000
    required_event: str = "payment_intent.succeeded"
def read_record(record_id):
    row = _db.execute("SELECT value FROM records WHERE id = ?", (record_id,)).fetchone()
    if row is None: raise HTTPException(404, "Record not found")
    return json.loads(row[0])
def save(record):
    _db.execute("UPDATE records SET value = ? WHERE id = ?", (json.dumps(record), record["id"]))
    _db.commit()
    print("[app] persisted record " + record["id"], flush=True)
def derive_state(record, provider):
    return {OUTPUT_FIELD: record["subtotal_cents"] * provider.get("percent_off", 0)}
@app.post("/records", status_code=201)
def create_record(body: Create):
    record = dict(body.model_dump(), id="record_" + uuid.uuid4().hex[:10])
    with _lock:
        _db.execute("INSERT INTO records VALUES (?, ?)", (record["id"], json.dumps(record)))
        _db.commit()
    return record
@app.get("/records/{record_id}")
def get_record(record_id: str):
    with _lock: return read_record(record_id)
@app.post("/records/{record_id}/sync")
def sync_record(record_id: str):
    with _lock:
        record = read_record(record_id)
        request_url = BASE + RESOURCE + ("/" + record["provider_id"] if PROVIDER_METHOD == "GET" else "")
        payload = json.dumps({"customer": record["customer_id"], "return_url": "https://example.test/return"}).encode() if PROVIDER_METHOD == "POST" else None
        req = urllib.request.Request(request_url, data=payload, method=PROVIDER_METHOD, headers={"Content-Type": "application/json", "Authorization": "Bearer " + KEY, "User-Agent": "fetchsandbox-workflow-fixture/1"})
        try:
            with urllib.request.urlopen(req, timeout=5) as response: provider = json.load(response)
        except Exception:
            raise HTTPException(503, "Provider read unavailable; state unchanged")
        changes = derive_state(record, provider)
        record.update(changes)
        save(record)
        return record
