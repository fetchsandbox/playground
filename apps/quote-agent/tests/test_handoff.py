"""Customer handoff (CRM -> billing -> welcome email), agent controls and the research agent.

The real HubSpot, Stripe and Resend client code runs against the in-memory fakes.
"""

import json
import threading
from types import SimpleNamespace

import pytest
from conftest import ADMIN_TOKEN, HANDOFF_TOKEN, VERIFIER_TOKEN
from test_workflow import CUSTOMER, email, send_initial_quote

from quote_agent.handoff.research import ClaudeBriefWriter, ReadOnlyHubSpot
from quote_agent.providers.hubspot import HubSpotError

AUTH = {"Authorization": f"Bearer {HANDOFF_TOKEN}"}   # what an external agent / CRM automation holds
OPS = {"Authorization": f"Bearer {ADMIN_TOKEN}"}      # operators: contain, pause, retry, verify, export


@pytest.fixture(autouse=True)
def _operator_and_verifier_tokens(settings):
    # Set before the app is built: the verifier routes exist only when their token is configured.
    settings.admin_token = ADMIN_TOKEN
    settings.verifier_token = VERIFIER_TOKEN


def start(client, quote_id):
    return client.post("/handoff/runs", json={"quote_id": quote_id, "requested_by": "rep@northwind.test"},
                       headers=AUTH)


def steps(run):
    return {s["name"]: s["status"] for s in run["steps"]}


def outcomes(orch, run_id, step=None):
    return [(a["step"], a["outcome"]) for a in orch.handoff.handoffs.list_actions(run_id)
            if step is None or a["step"] == step]


# ------------------------------------------------------------------ happy path


def test_handoff_completes_crm_then_invoice_then_email(client, orch, fake):
    quote = send_initial_quote(orch, fake)
    r = start(client, quote.id)
    assert r.status_code == 200, r.text
    run = r.json()
    assert run["created"] is True and run["status"] == "completed", run
    assert steps(run) == {"crm_lifecycle": "verified", "billing_invoice": "verified", "welcome_email": "verified"}

    contact = fake.contacts[quote.hubspot_contact_id]
    assert contact["properties"]["lifecyclestage"] == "customer"
    [invoice] = fake.invoices_for(CUSTOMER)
    assert invoice["status"] == "open" and invoice["total"] == quote.total_cents == 1_500_000
    assert invoice["metadata"] == {"handoff_run": run["id"], "quote_id": quote.id}
    assert invoice["auto_advance"] == "false"  # Stripe must not email the customer itself
    [welcome] = fake.resend_emails.values()
    assert welcome["to"] == [CUSTOMER] and invoice["number"] in welcome["text"] and "$15,000.00" in welcome["text"]

    # The log shows every agent's action allowed, executed and verified, in order.
    log = outcomes(orch, run["id"])
    for step in ("crm_lifecycle", "billing_invoice", "welcome_email"):
        assert [o for s, o in log if s == step] == ["allowed", "executed", "verified"]
    assert [s for s, o in log if o == "verified"] == ["crm_lifecycle", "billing_invoice", "welcome_email"]


def test_invoice_uses_the_approved_discounted_quote(client, orch, fake):
    send_initial_quote(orch, fake)
    paused = orch.handle_inbound(email("m-disc", "Can you do 25% off?"))
    orch.resume_approval(paused["approval_id"], "approved", "U_MANAGER")
    revised = orch.store.get_quote(paused["quote_id"])
    run = start(client, revised.id).json()
    assert run["status"] == "completed"
    [invoice] = fake.invoices_for(CUSTOMER)
    assert invoice["total"] == revised.total_cents == 1_125_000
    assert "25% discount applied" in invoice["lines"]["data"][0]["description"]


@pytest.mark.parametrize("make", ["pending_approval", "superseded"])
def test_only_the_sent_quote_can_be_handed_off(client, orch, fake, make):
    base = send_initial_quote(orch, fake)
    if make == "pending_approval":
        target = orch.store.get_quote(orch.handle_inbound(email("m-d", "Can you do 30% off?"))["quote_id"])
    else:
        orch.handle_inbound(email("m-d", "Can you do 5% off?"))
        target = orch.store.get_quote(base.id)
    assert target.status == make
    r = start(client, target.id)
    assert r.status_code == 409
    assert {"pending_approval": "waiting on discount approval", "superseded": "replaced"}[make] in r.text
    assert fake.stripe_invoices == {} and fake.resend_emails == {}


def test_unknown_quote_is_404(client):
    assert start(client, "Q-DEADBEEF").status_code == 404


def test_handoff_api_requires_token(client, orch, fake):
    quote = send_initial_quote(orch, fake)
    assert client.post("/handoff/runs", json={"quote_id": quote.id}).status_code == 401
    assert client.post("/handoff/runs", json={"quote_id": quote.id},
                       headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.get("/agents").status_code == 401
    assert fake.stripe_invoices == {}


# ------------------------------------------------------------- duplicates


def test_repeated_start_returns_the_same_run(client, orch, fake):
    quote = send_initial_quote(orch, fake)
    first = start(client, quote.id).json()
    second = start(client, quote.id).json()
    assert second["created"] is False and second["id"] == first["id"]
    assert len(fake.invoices_for(CUSTOMER)) == 1 and len(fake.resend_emails) == 1


def test_concurrent_starts_make_one_run(client, orch, fake):
    quote = send_initial_quote(orch, fake)
    results = []

    def go():
        results.append(start(client, quote.id).json())

    threads = [threading.Thread(target=go) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len({r["id"] for r in results}) == 1
    assert sum(r["created"] for r in results) == 1
    assert len(fake.invoices_for(CUSTOMER)) == 1 and len(fake.resend_emails) == 1


# ---------------------------------------------------------------- the gate


def test_crm_failure_stops_before_billing_and_email(client, orch, fake):
    quote = send_initial_quote(orch, fake)
    fake.hubspot_status = 401
    run = start(client, quote.id).json()
    assert run["status"] == "failed"
    assert steps(run) == {"crm_lifecycle": "failed", "billing_invoice": "pending", "welcome_email": "pending"}
    assert fake.stripe_requests == [] and fake.resend_emails == {}


def test_billing_failure_holds_the_email_and_retry_reuses_the_draft(client, orch, fake):
    quote = send_initial_quote(orch, fake)
    fake.stripe_fail["finalize"] = 500
    run = start(client, quote.id).json()
    assert run["status"] == "failed" and steps(run)["billing_invoice"] == "failed"
    assert steps(run)["welcome_email"] == "pending" and fake.resend_emails == {}
    [draft] = fake.invoices_for(CUSTOMER)
    assert draft["status"] == "draft" and len(draft["lines"]["data"]) == 1

    fake.stripe_fail.clear()
    run = client.post(f"/handoff/runs/{run['id']}/retry", headers=OPS).json()
    assert run["status"] == "completed"
    [invoice] = fake.invoices_for(CUSTOMER)  # the same invoice, finalized; no second line, no second invoice
    assert invoice["id"] == draft["id"] and invoice["status"] == "open" and len(invoice["lines"]["data"]) == 1
    assert len(fake.stripe_customers) == 1 and len(fake.resend_emails) == 1


def test_bounced_welcome_email_fails_verification(client, orch, fake):
    sent = orch.handle_inbound(email("m-b", "Quote for 25 seats of Pro please", sender="bounced@resend.dev"))
    run = start(client, sent["quote_id"]).json()
    assert run["status"] == "failed" and steps(run)["welcome_email"] == "failed"
    assert "not_bounced" in run["error"]
    assert ("welcome_email", "verification_failed") in outcomes(orch, run["id"])


# --------------------------------------------------------- lost responses


def test_lost_email_response_is_resolved_without_a_second_email(client, orch, fake):
    quote = send_initial_quote(orch, fake)
    fake.resend_lose_response = True
    run = start(client, quote.id).json()
    assert run["status"] == "completed", run
    assert len(fake.resend_emails) == 1 and fake.resend_replays == 1  # same key replayed, nothing re-sent
    email_step = next(s for s in run["steps"] if s["name"] == "welcome_email")
    assert email_step["resolved_from_uncertain"] is True and email_step["attempts"] == 2
    assert [o for s, o in outcomes(orch, run["id"], "welcome_email")] == [
        "allowed", "uncertain", "reconciling", "reconciled", "verified"]


@pytest.mark.parametrize("op", ["create_invoice", "create_item", "finalize", "create_customer"])
def test_lost_stripe_response_finds_what_was_made(client, orch, fake, op):
    quote = send_initial_quote(orch, fake)
    fake.stripe_lose_response.add(op)
    run = start(client, quote.id).json()
    assert run["status"] == "completed", run
    assert len(fake.stripe_customers) == 1
    [invoice] = fake.invoices_for(CUSTOMER)
    assert invoice["status"] == "open" and len(invoice["lines"]["data"]) == 1 and invoice["total"] == quote.total_cents
    assert len(fake.resend_emails) == 1


def test_lost_crm_response_rereads_the_contact(client, orch, fake):
    quote = send_initial_quote(orch, fake)
    fake.hubspot_lose_patch = True
    run = start(client, quote.id).json()
    assert run["status"] == "completed"
    patches = [w for w in fake.hubspot_writes if w[0] == "PATCH"]
    assert len(patches) == 1  # the reconcile read the stage and did not write again


def test_uncertain_step_waits_for_verify_when_auto_reconcile_is_off(client, orch, fake):
    orch.handoff.auto_reconcile = False
    quote = send_initial_quote(orch, fake)
    fake.resend_lose_response = True
    run = start(client, quote.id).json()
    assert run["status"] == "uncertain" and steps(run)["welcome_email"] == "uncertain"
    run = client.post(f"/handoff/runs/{run['id']}/verify", headers=OPS).json()
    assert run["status"] == "completed" and len(fake.resend_emails) == 1


def test_interrupted_step_is_marked_uncertain_then_verified(client, orch, fake):
    quote = send_initial_quote(orch, fake)
    orch.handoff.enqueue = lambda job: None  # nothing runs: simulate a worker dying mid-step
    run, _ = orch.handoff.start(quote.id, "rep")
    assert orch.handoff.handoffs.claim_step(run["id"], "crm_lifecycle", ("pending",))
    assert orch.handoff.reap_stale(-1) == [run["id"]]
    assert orch.handoff.handoffs.get_run(run["id"])["status"] == "uncertain"
    orch.handoff.enqueue = None
    run = client.post(f"/handoff/runs/{run['id']}/verify", headers=OPS).json()
    assert run["status"] == "completed" and len(fake.resend_emails) == 1


# ------------------------------------------------------- pause and contain


def test_pause_stops_new_steps_and_resume_continues(client, orch, fake):
    quote = send_initial_quote(orch, fake)
    queued = []
    orch.handoff.enqueue = queued.append
    run, _ = orch.handoff.start(quote.id, "rep")
    orch.handoff.advance(queued.pop(0)["run_id"])  # CRM step runs
    client.post(f"/handoff/runs/{run['id']}/pause", headers=OPS)
    orch.handoff.advance(queued.pop(0)["run_id"])  # billing job arrives while paused: nothing happens
    paused = orch.handoff.handoffs.get_run(run["id"])
    assert paused["status"] == "paused" and steps(paused)["billing_invoice"] == "pending"
    assert fake.stripe_requests == []

    orch.handoff.enqueue = None
    run = client.post(f"/handoff/runs/{run['id']}/resume", headers=OPS).json()
    assert run["status"] == "completed" and len(fake.resend_emails) == 1


def test_pause_holds_a_retried_run_until_resume(client, orch, fake):
    quote = send_initial_quote(orch, fake)
    client.post("/agents/billing/contain", headers=OPS)
    run = start(client, quote.id).json()
    assert run["status"] == "blocked"
    client.post(f"/handoff/runs/{run['id']}/pause", headers=OPS)
    client.post("/agents/billing/release", headers=OPS)
    held = client.post(f"/handoff/runs/{run['id']}/retry", headers=OPS).json()
    assert held["status"] == "paused" and steps(held)["billing_invoice"] == "pending"
    assert fake.stripe_requests == [] and fake.resend_emails == {}
    done = client.post(f"/handoff/runs/{run['id']}/resume", headers=OPS).json()
    assert done["status"] == "completed" and len(fake.invoices_for(CUSTOMER)) == 1
    assert client.post(f"/handoff/runs/{run['id']}/pause", headers=OPS).status_code == 409


def test_contained_agent_is_blocked_and_release_lets_retry_finish(client, orch, fake):
    quote = send_initial_quote(orch, fake)
    assert client.post("/agents/billing/contain", headers=OPS).json()["contained"] is True
    run = start(client, quote.id).json()
    assert run["status"] == "blocked" and steps(run)["billing_invoice"] == "failed"
    assert fake.stripe_requests == [] and fake.resend_emails == {}
    assert ("billing_invoice", "blocked") in outcomes(orch, run["id"])

    client.post("/agents/billing/release", headers=OPS)
    run = client.post(f"/handoff/runs/{run['id']}/retry", headers=OPS).json()
    assert run["status"] == "completed"


def test_contain_marks_an_in_flight_step_uncertain(client, orch, fake):
    quote = send_initial_quote(orch, fake)
    orch.handoff.enqueue = lambda job: None
    run, _ = orch.handoff.start(quote.id, "rep")
    orch.handoff.handoffs.claim_step(run["id"], "crm_lifecycle", ("pending",))
    result = orch.handoff.contain("crm", "secops")
    assert result["in_flight_marked_uncertain"] == [run["id"]]
    assert steps(orch.handoff.handoffs.get_run(run["id"]))["crm_lifecycle"] == "uncertain"


def test_agents_endpoint_lists_manifests(client):
    agents = {a["name"]: a for a in client.get("/agents", headers=AUTH).json()["agents"]}
    assert set(agents) == {"quote", "research", "crm", "billing", "messaging"}
    assert agents["billing"]["actions"] == ["billing.issue_invoice"] and agents["billing"]["systems"] == ["stripe"]
    assert agents["research"]["read_only"] is True and agents["messaging"]["customer_facing"] is True


def test_action_outside_the_allowlist_is_blocked(orch):
    from quote_agent.handoff.gateway import ActionBlocked
    with pytest.raises(ActionBlocked):
        orch.handoff.gateway.perform("crm", "billing.issue_invoice", {}, lambda: "never runs")


# ------------------------------------------------------------- research


def test_research_brief_is_read_only_and_uses_allowlisted_fields(client, orch, fake):
    quote = send_initial_quote(orch, fake)
    fake.contacts[quote.hubspot_contact_id]["properties"].update(company="Acme", phone="+1 555 0100",
                                                                 jobtitle="CFO")
    writes_before = list(fake.hubspot_writes)
    brief = client.post("/research/briefs", json={"customer_email": CUSTOMER}, headers=AUTH).json()
    assert brief["facts"]["contact"]["company"] == "Acme" and brief["facts"]["contact"]["jobtitle"] == "CFO"
    assert "phone" not in brief["facts"]["contact"] and "email" not in brief["facts"]["contact"]
    assert brief["facts"]["quotes"][0]["id"] == quote.id and brief["written_by"] == "rules"
    assert fake.hubspot_writes == writes_before


def test_read_only_hubspot_refuses_writes(fake):
    hs = ReadOnlyHubSpot("https://hubspot.test", "hs-token", http=fake.client())
    with pytest.raises(HubSpotError, match="read-only"):
        hs.update_contact("101", {"lifecyclestage": "customer"})
    with pytest.raises(HubSpotError, match="read-only"):
        hs.ensure_contact("new@acme.test")  # search is allowed, the create is refused
    assert fake.hubspot_writes == []


def test_research_sends_only_allowlisted_fields_to_claude(client, orch, fake):
    quote = send_initial_quote(orch, fake)
    fake.contacts[quote.hubspot_contact_id]["properties"].update(company="Acme", phone="+1 555 0100")
    calls = []
    payload = {"summary": "Dana at Acme has a sent quote.", "talking_points": ["Pro x25"], "open_questions": []}
    claude = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(create=lambda **kw: calls.append(kw) or
        SimpleNamespace(stop_reason="end_turn", model="claude-opus-5-5",
                        content=[SimpleNamespace(type="text", text=json.dumps(payload))]))))
    orch.research.writer = ClaudeBriefWriter(claude)
    brief = client.post("/research/briefs", json={"customer_email": CUSTOMER}, headers=AUTH).json()
    assert brief["summary"] == payload["summary"] and brief["written_by"] == "claude:claude-opus-5-5"
    sent = calls[0]["messages"][0]["content"]
    assert "Acme" in sent and CUSTOMER not in sent and "555" not in sent
    assert set(brief["fields_shared_with_model"]) == {"company", "firstname", "lastname", "quotes", "handoff"}


def test_contained_research_agent_is_refused(client, orch, fake):
    client.post("/agents/research/contain", headers=OPS)
    assert client.post("/research/briefs", json={"customer_email": CUSTOMER}, headers=AUTH).status_code == 403


# ------------------------------------------------------ separation of duties


def test_the_start_token_cannot_change_the_controls(client, orch, fake):
    quote = send_initial_quote(orch, fake)
    run = start(client, quote.id).json()
    for path in ("/agents/billing/contain", "/agents/billing/release", f"/handoff/runs/{run['id']}/pause",
                 f"/handoff/runs/{run['id']}/retry", f"/handoff/runs/{run['id']}/verify"):
        assert client.post(path, headers=AUTH).status_code == 401, path
    assert client.get("/actions", headers=AUTH).status_code == 401
    assert client.get("/actions", headers=OPS).status_code == 200
    assert not orch.handoff.gateway.is_contained("billing")


# ------------------------------------------------------ per-agent workers


def test_a_redelivered_job_is_sent_to_the_next_agents_queue(client, orch, fake):
    quote = send_initial_quote(orch, fake)
    queued = []
    orch.handoff.enqueue = queued.append
    run, _ = orch.handoff.start(quote.id, "rep")
    assert queued[-1]["agent"] == "crm"
    orch.handoff.advance(run["id"], "crm")
    assert queued[-1]["agent"] == "billing"
    # The CRM job is delivered again (SQS at-least-once) to the CRM worker after its step is done:
    orch.handoff.advance(run["id"], "crm")
    assert fake.stripe_requests == []  # the CRM worker did not run the billing step
    assert queued[-1] == {"type": "handoff_advance", "run_id": run["id"], "agent": "billing"}
    orch.handoff.advance(run["id"], "billing")
    orch.handoff.advance(run["id"], "messaging")
    assert orch.handoff.handoffs.get_run(run["id"])["status"] in {"running", "completed"}
    orch.handoff.advance(run["id"], "handoff")
    assert orch.handoff.handoffs.get_run(run["id"])["status"] == "completed"


# ------------------------------------------------------ verifier observer


def test_verifier_handoff_state_reports_saved_effects(client, orch, fake):
    quote = client.post("/dev/quotes", json={"customer_email": "obs-1@example.com", "product": "starter",
                                             "seats": 10}).json()
    assert quote["status"] == "sent" and quote["total_cents"] == 240_000
    fake.resend_lose_response = True
    start(client, quote["id"])
    V = {"Authorization": f"Bearer {VERIFIER_TOKEN}"}
    assert client.get("/verifier/handoff/obs-1/state").status_code == 401
    state = client.get("/verifier/handoff/obs-1/state", headers=V).json()
    [run] = state["runs"]
    assert run["status"] == "completed" and run["billing_invoices_created"] == 1 and len(run["invoice_ids"]) == 1
    assert run["welcome_emails_sent"] == 1 and run["uncertain_events"] == 1 and run["first_failure"] is None
    assert next(st for st in run["steps"] if st["name"] == "welcome_email")["resolved_from_uncertain"] is True
    client.post("/research/briefs", json={"customer_email": "obs-1@example.com"}, headers=AUTH)
    [brief] = client.get("/verifier/handoff/obs-1/state", headers=V).json()["research"]
    assert brief["email_in_fields_read"] is False and brief["crm_writes_refused"] == 0
