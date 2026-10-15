"""In-memory HubSpot, Slack and Gmail served through httpx.MockTransport.

The real provider clients run unmodified against these, so the tests cover
request shapes, ok:false handling and read-backs — not just orchestration.
"""

import base64
import json
from email import message_from_bytes
from urllib.parse import urlencode

import httpx

HUBSPOT = "https://hubspot.test"
SLACK = "https://slack.test/api"
GMAIL = "https://gmail.test/gmail/v1"
GOOGLE_TOKEN = "https://oauth.test/token"


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
        return httpx.Response(404)

    # ----------------------------------------------------------- HubSpot

    def _hubspot(self, req, path):
        if req.headers.get("Authorization") != "Bearer hs-token":
            return httpx.Response(401, json={"message": "auth"})
        body = json.loads(req.content) if req.content else {}
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
            return httpx.Response(200, json=c) if c else httpx.Response(404)
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
        if path == "/users/me/messages/send":
            body = json.loads(req.content)
            raw = base64.urlsafe_b64decode(body["raw"] + "=" * (-len(body["raw"]) % 4))
            mime = message_from_bytes(raw)
            self.emails_sent.append({"to": mime["To"], "subject": mime["Subject"], "in_reply_to": mime["In-Reply-To"],
                                     "thread_id": body.get("threadId"), "body": mime.get_payload(decode=True).decode()})
            return httpx.Response(200, json={"id": f"sent-{len(self.emails_sent)}", "threadId": body.get("threadId")})
        return httpx.Response(404)


def form_payload(payload: dict) -> bytes:
    return urlencode({"payload": json.dumps(payload)}).encode()
