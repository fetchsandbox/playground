"""Read-only test adapter for external verification (e.g. FetchSandbox).

Disabled unless QUOTE_AGENT_VERIFIER_TOKEN is set, and every route requires
that token as a Bearer header. It never writes: it only exposes saved run and
quote state so a verifier can assert on what the app actually did, scoped to
the inbound message ids it sent.
"""

import secrets
import uuid

from fastapi import APIRouter, Header, HTTPException

from .orchestrator import Orchestrator

INSTANCE_ID = uuid.uuid4().hex  # changes on every process start


def build_router(orch: Orchestrator, token: str) -> APIRouter:
    router = APIRouter(prefix="/verifier", include_in_schema=False)

    def _auth(authorization: str | None) -> None:
        if not authorization or not secrets.compare_digest(authorization, f"Bearer {token}"):
            raise HTTPException(401, "verifier token required")

    @router.get("/runtime")
    def runtime(authorization: str | None = Header(None)):
        _auth(authorization)
        return {"instance_id": INSTANCE_ID}

    @router.get("/scopes/{scope}/state")
    def scope_state(scope: str, authorization: str | None = Header(None)):
        """Runs whose inbound message id starts with `scope` or whose text carries it, plus quotes and approvals."""
        _auth(authorization)
        runs = [r for r in orch.store.list_runs(limit=1000)
                if str(r.get("inbound", {}).get("external_id", "")).startswith(scope)
                or scope in str(r.get("inbound", {}).get("text", ""))]
        runs.sort(key=lambda r: r["created_at"])
        out = []
        for r in runs:
            quote = orch.store.get_quote(r["quote_id"]) if r.get("quote_id") else None
            approval = orch.store.get_approval(r["approval_id"]) if r.get("approval_id") else None
            out.append({
                "id": r["id"],
                "external_id": r["inbound"]["external_id"],
                "channel": r["inbound"]["channel"],
                "sender_email": r["inbound"].get("sender_email"),
                "status": r["status"],
                "error": r.get("error"),
                "intent": (r.get("classification") or {}).get("intent"),
                "discount_decision": (r.get("discount") or {}).get("decision"),
                "requested_pct": (r.get("discount") or {}).get("requested_pct"),
                "approval_id": r.get("approval_id"),
                "approval_status": approval["status"] if approval else None,
                "approval_decided_by": (r.get("approval_decision") or {}).get("by"),
                "quote": quote.model_dump(include={"id", "status", "version", "parent_quote_id", "subtotal_cents",
                                                   "discount_pct", "discount_cents", "total_cents",
                                                   "hubspot_contact_id", "hubspot_deal_id"}) if quote else None,
                "steps": [{"name": s["name"], "status": s["status"]} for s in r["steps"]],
            })
        # Every quote these runs touched, including the originals a discount revised.
        ids: list[str] = []
        for o in out:
            for qid in ((o["quote"] or {}).get("id"), (o["quote"] or {}).get("parent_quote_id")):
                if qid and qid not in ids:
                    ids.append(qid)
        quotes = [q.model_dump(include={"id", "status", "total_cents", "discount_pct"})
                  for q in (orch.store.get_quote(i) for i in ids) if q]
        return {"scope": scope, "runs": out, "run_count": len(out), "quotes": quotes}

    return router
