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

    @router.get("/handoff/{scope}/state")
    def handoff_state(scope: str, authorization: str | None = Header(None)):
        """Handoff runs for customers whose email starts with `scope`, judged from saved state and the action log."""
        _auth(authorization)
        if orch.handoff is None:
            raise HTTPException(404, "handoff not configured")
        hs = orch.handoff.handoffs
        prefix = scope.lower()
        quotes = [q for q in orch.store.list_quotes(limit=1000) if q.customer_email.lower().startswith(prefix)]
        runs = []
        for q in quotes:
            run = hs.get_run_by_quote(q.id)
            if run is None:
                continue
            actions = hs.list_actions(run["id"])
            done = [a for a in actions if a["outcome"] in {"executed", "reconciled", "verified"}]
            billing = [a["detail"] for a in done if a["agent"] == "billing"]
            messaging = [a["detail"] for a in done if a["agent"] == "messaging"]
            failure = next((a for a in actions if a["outcome"] in {"failed", "blocked", "verification_failed"}), None)
            runs.append({
                "id": run["id"], "quote_id": run["quote_id"], "status": run["status"], "error": run.get("error"),
                "amount_cents": run["amount_cents"],
                "steps": [{"name": st["name"], "status": st["status"], "attempts": st["attempts"],
                           "resolved_from_uncertain": bool(st.get("resolved_from_uncertain"))} for st in run["steps"]],
                "billing_invoices_created": sum(1 for d in billing if d.get("invoice_created")),
                "invoice_ids": sorted({d["invoice_id"] for d in billing if d.get("invoice_id")}),
                "welcome_emails_sent": len({d["email_id"] for d in messaging if d.get("email_id")}),
                "uncertain_events": sum(1 for a in actions if a["outcome"] == "uncertain"),
                "first_failure": {"step": failure["step"], "outcome": failure["outcome"]} if failure else None,
            })
        research = [{"fields_read": a["detail"].get("fields_read", []),
                     "email_in_fields_read": "email" in a["detail"].get("fields_read", []),
                     "crm_writes_refused": a["detail"].get("crm_writes_refused", 0),
                     "written_by": a["detail"].get("written_by")}
                    for a in hs.list_actions(limit=1000)
                    if a["action"] == "research.brief"
                    and str(a["detail"].get("customer_email", "")).startswith(prefix)]
        return {"scope": scope, "quotes": [{"id": q.id, "status": q.status, "total_cents": q.total_cents} for q in quotes],
                "runs": runs, "run_count": len(runs), "research": research,
                "contained_agents": [m["name"] for m in orch.handoff.gateway.manifests() if m["contained"]]}

    return router
