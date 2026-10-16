"""In-memory HubSpot, Slack, Gmail, Stripe and Resend served through httpx.MockTransport.

The real provider clients run unmodified against these, so the tests cover
request shapes, ok:false handling and read-backs — not just orchestration.
"""

import base64
import json
from email import message_from_bytes
from urllib.parse import parse_qsl, urlencode

import httpx

HUBSPOT = "https://hubspot.test"
SLACK = "https://slack.test/api"
GMAIL = "https://gmail.test/gmail/v1"
GOOGLE_TOKEN = "https://oauth.test/token"
STRIPE = "https://stripe.test"
RESEND = "https://resend.test"


class FakeProviders:
    def __init__(self):
        self.contacts: dict[str, dict] = {}
        self.deals: dict[str, dict] = {}
        self.slack_posts: list[dict] = []
        self.slack_updates: list[dict] = []
        self.slack_users = {"U_CUSTOMER": {"email": "dana@acme.test", "real_name": "Dana Scully"}}
        self.slack_fail_channel: str | None = None
        self.emails_sent: list[dict] = []
        self.gmail_inbox: dict[str, dict] = {}
        self.gmail_history: list[str] = []
        self._next = 100
        # Fault switches. hubspot_status / stripe_status / resend_status force a response status;
        # stripe_fail maps an operation name to a status; *_lose_response loses the response of the
        # next matching request AFTER its effect is applied (the request reached the provider).
        self.hubspot_status: int | None = None
        self.hubspot_lose_patch = False
        self.stripe_status: int | None = None
        self.stripe_fail: dict[str, int] = {}
        self.stripe_lose_response: set[str] = set()
        self.resend_status: int | None = None
        self.resend_lose_response = False
        # Stripe: like the FetchSandbox twin, this fake does NOT honour Idempotency-Key, so the
        # billing agent's find-before-create is what prevents duplicates.
        self.stripe_customers: dict[str, dict] = {}
        self.stripe_invoices: dict[str, dict] = {}
        self.stripe_requests: list[tuple[str, str]] = []
        # Resend honours Idempotency-Key (24h): a repeat returns the original email, sends nothing.
        self.resend_emails: dict[str, dict] = {}
        self.resend_keys: dict[str, str] = {}
        self.resend_replays = 0
        self.hubspot_writes: list[tuple[str, str]] = []
        self.transport = httpx.MockTransport(self.handle)

    def client(self) -> httpx.Client:
        return httpx.Client(transport=self.transport)

    def _id(self) -> str:
        self._next += 1
        return str(self._next)

    def handle(self, req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        if url.startswith(HUBSPOT):
            return self._hubspot(req, req.url.path)
        if url.startswith(SLACK):
            return self._slack(req, req.url.path.rsplit("/", 1)[-1])
        if url.startswith(GMAIL):
            return self._gmail(req, req.url.path[len("/gmail/v1"):])
        if url.startswith(STRIPE):
            return self._stripe(req, req.url.path)
        if url.startswith(RESEND):
            return self._resend(req, req.url.path)
        return httpx.Response(404)

    # ----------------------------------------------------------- HubSpot

    def _hubspot(self, req, path):
        if req.headers.get("Authorization") != "Bearer hs-token":
            return httpx.Response(401, json={"message": "auth"})
        if self.hubspot_status:
            return httpx.Response(self.hubspot_status, json={"message": "forced"})
        body = json.loads(req.content) if req.content else {}
        if req.method != "GET" and not path.endswith("/search"):
            self.hubspot_writes.append((req.method, path))
        if path == "/crm/v3/objects/contacts/search":
            email = body["filterGroups"][0]["filters"][0]["value"].lower()
            hits = [c for c in self.contacts.values() if c["properties"]["email"].lower() == email]
            return httpx.Response(200, json={"total": len(hits), "results": hits[:1]})
        if path == "/crm/v3/objects/contacts" and req.method == "POST":
            email = body["properties"]["email"].lower()
            for c in self.contacts.values():
                if c["properties"]["email"].lower() == email:
                    return httpx.Response(409, json={"message": f"Contact already exists. Existing ID: {c['id']}"})
            cid = self._id()
            self.contacts[cid] = {"id": cid, "properties": dict(body["properties"])}
            return httpx.Response(201, json=self.contacts[cid])
        if path.startswith("/crm/v3/objects/contacts/"):
            c = self.contacts.get(path.rsplit("/", 1)[-1])
            if not c:
                return httpx.Response(404)
            if req.method == "PATCH":
                c["properties"].update(body["properties"])
                if self.hubspot_lose_patch:
                    self.hubspot_lose_patch = False
                    raise httpx.ReadTimeout("response lost", request=req)
            return httpx.Response(200, json=c)
        if path == "/crm/v3/objects/deals" and req.method == "POST":
            did = self._id()
            self.deals[did] = {"id": did, "properties": dict(body["properties"]),
                               "associations": body.get("associations", [])}
            return httpx.Response(201, json=self.deals[did])
        if path.startswith("/crm/v3/objects/deals/"):
            d = self.deals.get(path.rsplit("/", 1)[-1])
            if not d:
                return httpx.Response(404)
            if req.method == "PATCH":
                d["properties"].update(body["properties"])
            return httpx.Response(200, json=d)
        return httpx.Response(404)

    # ------------------------------------------------------------- Slack

    def _slack(self, req, method):
        if req.headers.get("Authorization") != "Bearer xoxb-test":
            return httpx.Response(200, json={"ok": False, "error": "invalid_auth"})
        if method == "users.info":
            user = req.url.params["user"]
            prof = self.slack_users.get(user)
            if not prof:
                return httpx.Response(200, json={"ok": False, "error": "user_not_found"})
            return httpx.Response(200, json={"ok": True, "user": {"id": user, "profile": prof}})
        body = json.loads(req.content)
        if method == "chat.postMessage":
            if body["channel"] == self.slack_fail_channel:
                return httpx.Response(200, json={"ok": False, "error": "channel_not_found"})
            ts = f"1700000000.{len(self.slack_posts):06d}"
            self.slack_posts.append({**body, "ts": ts})
            return httpx.Response(200, json={"ok": True, "channel": body["channel"], "ts": ts})
        if method == "chat.update":
            self.slack_updates.append(body)
            return httpx.Response(200, json={"ok": True, "channel": body["channel"], "ts": body["ts"]})
        return httpx.Response(200, json={"ok": False, "error": "unknown_method"})

    # ------------------------------------------------------------- Gmail

    def add_inbound_email(self, *, msg_id, sender, subject, body, history_id):
        self.gmail_inbox[msg_id] = {
            "id": msg_id, "threadId": f"t-{msg_id}", "labelIds": ["INBOX", "UNREAD"],
            "payload": {"mimeType": "multipart/alternative",
                        "headers": [{"name": "From", "value": sender}, {"name": "Subject", "value": subject},
                                    {"name": "Message-ID", "value": f"<{msg_id}@mail.test>"}],
                        "parts": [{"mimeType": "text/plain",
                                   "body": {"data": base64.urlsafe_b64encode(body.encode()).decode().rstrip("=")}}]},
        }
        self.gmail_history.append(msg_id)

    def _gmail(self, req, path):
        if req.headers.get("Authorization") != "Bearer gm-token":
            return httpx.Response(401)
        if path == "/users/me/history":
            ids = self.gmail_history
            return httpx.Response(200, json={"history": [
                {"messagesAdded": [{"message": {"id": i, "labelIds": ["INBOX"]}}]} for i in ids]})
        if path == "/users/me/messages" and req.method == "GET":
            return httpx.Response(200, json={"messages": [{"id": i} for i in self.gmail_history]})
        if path.startswith("/users/me/messages/") and req.method == "GET":
            m = self.gmail_inbox.get(path.rsplit("/", 1)[-1])
            return httpx.Response(200, json=m) if m else httpx.Response(404)
        if path == "/users/me/watch":
            self.gmail_watch = json.loads(req.content)
            return httpx.Response(200, json={"historyId": "4242", "expiration": "1790000000000"})
        if path == "/users/me/messages/send":
            body = json.loads(req.content)
            raw = base64.urlsafe_b64decode(body["raw"] + "=" * (-len(body["raw"]) % 4))
            mime = message_from_bytes(raw)
            self.emails_sent.append({"to": mime["To"], "subject": mime["Subject"], "in_reply_to": mime["In-Reply-To"],
                                     "thread_id": body.get("threadId"), "body": mime.get_payload(decode=True).decode()})
            return httpx.Response(200, json={"id": f"sent-{len(self.emails_sent)}", "threadId": body.get("threadId")})
        return httpx.Response(404)


    # ------------------------------------------------------------ Stripe

    def _stripe(self, req, path):
        if req.headers.get("Authorization") != "Bearer sk_test_fake":
            return httpx.Response(401, json={"error": {"message": "Invalid API Key"}})
        if self.stripe_status:
            return httpx.Response(self.stripe_status, json={"error": {"message": "forced"}})
        form = dict(parse_qsl(req.content.decode())) if req.content else {}
        meta = {k[9:-1]: v for k, v in form.items() if k.startswith("metadata[")}
        parts = path.strip("/").split("/")[1:]  # drop "v1"
        op = {("customers",): "create_customer" if req.method == "POST" else "list_customers",
              ("invoiceitems",): "create_item",
              ("invoices",): "create_invoice" if req.method == "POST" else "list_invoices"}.get(tuple(parts))
        if len(parts) == 2 and parts[0] == "invoices":
            op = "get_invoice"
        if len(parts) == 3 and parts[2] == "finalize":
            op = "finalize"
        self.stripe_requests.append((req.method, op))
        if op in self.stripe_fail:
            return httpx.Response(self.stripe_fail[op], json={"error": {"message": f"forced {op}"}})

        def out(obj, status=200):
            if op in self.stripe_lose_response:
                self.stripe_lose_response.discard(op)
                raise httpx.ReadTimeout("response lost", request=req)
            return httpx.Response(status, json=obj)

        if op == "list_customers":
            email = req.url.params.get("email", "").lower()
            return out({"data": [c for c in self.stripe_customers.values() if c["email"].lower() == email]})
        if op == "create_customer":
            cid = f"cus_{self._id()}"
            self.stripe_customers[cid] = {"id": cid, "email": form["email"], "name": form.get("name"), "metadata": meta}
            return out(self.stripe_customers[cid])
        if op == "list_invoices":
            cust = req.url.params.get("customer")
            return out({"data": [{k: v for k, v in i.items() if k != "lines"}
                                 for i in self.stripe_invoices.values() if i["customer"] == cust]})
        if op == "create_invoice":
            iid = f"in_{self._id()}"
            self.stripe_invoices[iid] = {"id": iid, "customer": form["customer"], "status": "draft", "currency": "usd",
                                         "total": 0, "metadata": meta, "number": None, "hosted_invoice_url": None,
                                         "auto_advance": form.get("auto_advance"), "lines": {"data": []}}
            return out(self.stripe_invoices[iid])
        if op == "create_item":
            inv = self.stripe_invoices[form["invoice"]]
            line = {"id": f"il_{self._id()}", "amount": int(form["amount"]), "description": form.get("description")}
            inv["lines"]["data"].append(line)
            inv["total"] = sum(l["amount"] for l in inv["lines"]["data"])
            return out({"id": f"ii_{line['id']}", **line})
        inv = self.stripe_invoices.get(parts[1]) if len(parts) > 1 else None
        if inv is None:
            return httpx.Response(404, json={"error": {"message": "No such invoice"}})
        if op == "finalize":
            if inv["status"] != "draft":
                return httpx.Response(400, json={"error": {"message": "Invoice is already finalized"}})
            inv.update(status="open", number=f"NW-{inv['id'][3:]}", hosted_invoice_url=f"https://pay.test/{inv['id']}")
        return out(inv)

    def invoices_for(self, email: str) -> list[dict]:
        ids = {c["id"] for c in self.stripe_customers.values() if c["email"].lower() == email.lower()}
        return [i for i in self.stripe_invoices.values() if i["customer"] in ids]

    # ------------------------------------------------------------ Resend

    def _resend(self, req, path):
        if req.headers.get("Authorization") != "Bearer re_fake":
            return httpx.Response(401, json={"message": "API key is invalid"})
        if self.resend_status:
            return httpx.Response(self.resend_status, json={"message": "forced"})
        if path == "/emails" and req.method == "POST":
            key = req.headers.get("Idempotency-Key")
            if key in self.resend_keys:
                self.resend_replays += 1
                return httpx.Response(200, json={"id": self.resend_keys[key]})
            body = json.loads(req.content)
            eid = f"em_{self._id()}"
            bounced = any(t.startswith("bounced@") for t in body["to"])
            self.resend_emails[eid] = {"object": "email", "id": eid, "to": body["to"], "from": body["from"],
                                       "subject": body["subject"], "text": body["text"],
                                       "last_event": "bounced" if bounced else "delivered"}
            if key:
                self.resend_keys[key] = eid
            if self.resend_lose_response:
                self.resend_lose_response = False
                raise httpx.ReadTimeout("response lost", request=req)
            return httpx.Response(200, json={"id": eid})
        if path.startswith("/emails/") and req.method == "GET":
            e = self.resend_emails.get(path.rsplit("/", 1)[-1])
            return httpx.Response(200, json=e) if e else httpx.Response(404, json={"message": "not found"})
        return httpx.Response(404)


def form_payload(payload: dict) -> bytes:
    return urlencode({"payload": json.dumps(payload)}).encode()
