"""application_workflow_v1 contract for the customer handoff, driven by FetchSandbox through its managed relay.

FetchSandbox calls the real app's HTTP entry points over the relay, injects provider faults at the HubSpot,
Stripe, Resend and Slack twins, and judges the app's saved state read from the protected, read-only
GET /verifier/handoff/{scope}/state observer. Every check scopes its records to {{run_id}}.

Entry points used (all real routes; /dev/* exist only with DEV_ENDPOINTS=true):
  POST /dev/inbound                       quote agent, the normal quote/discount workflow
  POST /dev/approvals/{id}/approved       stands in for the manager's Slack button
  POST /dev/quotes                        fixture: a sent quote without touching providers (lets a HubSpot
                                          fault be armed for the handoff without failing the quote first)
  POST /handoff/runs                      start the handoff (what a CRM automation / external agent calls)
  POST /handoff/runs/{id}/retry           operator retry after a failure is cleared
  POST /agents/{agent}/contain|release    the per-agent stop button

    python verification/handoff_contract.py <session_id>   ->  JSON for validate_integration
"""

import json
import sys

SESSION = sys.argv[1]
CH = "C0BILLING01"


def S(tag):
    return f"/verifier/handoff/{{{{run_id}}}}-{tag}/state"


def who(tag):
    return f"{{{{run_id}}}}-{tag}@example.com"


def inbound(tag, text, n=1):
    ts = f"17{abs(hash((tag, n))) % 10**8:08d}.000100"
    return {"method": "POST", "path": "/dev/inbound", "expect_status": 200, "body": {
        "channel": "slack", "external_id": f"{{{{run_id}}}}-{tag}-{n}", "sender_email": who(tag),
        "sender_name": "Dana Scully", "subject": "Pricing", "text": text,
        "reply_ref": {"channel": CH, "ts": ts, "thread_ts": ts, "user": "U0BOB00001"}}}


def fixture_quote(tag, seats=10, product="starter"):
    return {"method": "POST", "path": "/dev/quotes", "expect_status": 200,
            "body": {"customer_email": who(tag), "customer_name": "Dana Scully", "product": product, "seats": seats}}


def start(quote_ref, expect=200, concurrency=None):
    a = {"method": "POST", "path": "/handoff/runs", "expect_status": expect,
         "body": {"quote_id": quote_ref, "requested_by": "fetchsandbox"}}
    if concurrency:
        a["concurrency"] = concurrency
    return a


def post(path, expect=200):
    return {"method": "POST", "path": path, "expect_status": expect}


def eq(sel, val, required=True):
    return {"select": sel, "equals": val, "required": required}


def runs(count, *where):
    a = {"select": "runs[*]", "count": count, "required": True}
    if where:
        a["where"] = list(where)
    return a


def step(name, status, **extra):
    w = [eq("name", name), eq("status", status)] + [eq(k, v) for k, v in extra.items()]
    return {"select": "steps[*]", "count": 1, "required": True, "where": w}


EMPTY = {"select": "runs[*]", "count": 0, "required": True}
ALL_VERIFIED = [step("crm_lifecycle", "verified"), step("billing_invoice", "verified"), step("welcome_email", "verified")]


def check(cid, name, tag, actions, assertion, fault=None, deadline=30):
    c = {"id": cid, "name": name, "before": {"path": S(tag), "assertion": EMPTY}, "actions": actions,
         "observe": {"path": S(tag)}, "assertion": assertion, "observation_deadline_seconds": deadline}
    if fault:
        c["fault"] = fault
    return c


def blocked(cid, name, category, reason, evidence):
    return {"id": cid, "name": name, "blocker": {"category": category, "reason": reason, "evidence": evidence}}


def refusal_then_recovery(cid, name, tag, provider, scenario, failed_step, later_pending):
    """The fault refuses one agent's calls: the run stops at that step and later steps never run.
    After the fault is cleared, an operator retry finishes the run with one of everything."""
    stopped = [step(failed_step, "failed")] + [step(s, "pending") for s in later_pending]
    return check(cid, name, tag,
                 [fixture_quote(tag), start("{{step1.id}}"),
                  {"provider_control": {"provider": provider, "scenario": "default"}},
                  post("/handoff/runs/{{step2.id}}/retry")],
                 runs(1, eq("status", "completed"), eq("first_failure.step", failed_step),
                      eq("billing_invoices_created", 1), eq("welcome_emails_sent", 1), *ALL_VERIFIED),
                 fault={"provider": provider, "scenario": scenario}, deadline=60) | {"_stopped": stopped}


checks = [
    check("baseline", "Sent quote is handed off: CRM customer, one invoice for the quote total, one welcome email",
          "base",
          [inbound("base", "Hi, can we get a quote for 25 seats of Pro?"), start("{{step1.quote_id}}")],
          runs(1, eq("status", "completed"), eq("amount_cents", 1500000), eq("billing_invoices_created", 1),
               eq("welcome_emails_sent", 1), *ALL_VERIFIED)),
    check("approved_discount_is_billed", "A manager-approved 25% discount is what gets invoiced", "disc",
          [inbound("disc", "Hi, can we get a quote for 25 seats of Pro?"),
           inbound("disc", "Can you do 25% off?", 2), post("/dev/approvals/{{step2.approval_id}}/approved"),
           start("{{step2.quote_id}}")],
          runs(1, eq("status", "completed"), eq("amount_cents", 1125000), *ALL_VERIFIED)),
    check("pending_approval_refused", "A quote still waiting on discount approval cannot be handed off", "pend",
          [inbound("pend", "Hi, can we get a quote for 25 seats of Pro?"),
           inbound("pend", "We need 30% off to sign.", 2), start("{{step2.quote_id}}", expect=409)],
          {"all_of": [EMPTY, {"select": "quotes[*]", "count": 1, "required": True,
                              "where": [eq("status", "pending_approval")]}]}),
    check("superseded_refused", "A quote replaced by a revision cannot be handed off", "sup",
          [inbound("sup", "Hi, can we get a quote for 25 seats of Pro?"), inbound("sup", "Could you do 5% off?", 2),
           start("{{step1.quote_id}}", expect=409)],
          {"all_of": [EMPTY, {"select": "quotes[*]", "count": 1, "required": True,
                              "where": [eq("status", "superseded")]}]}),
    check("repeat_start", "Starting the same handoff twice gives one run, one invoice, one email", "rep",
          [fixture_quote("rep"), start("{{step1.id}}"), start("{{step1.id}}")],
          runs(1, eq("status", "completed"), eq("billing_invoices_created", 1), eq("welcome_emails_sent", 1))),
    check("concurrent_start", "Four overlapping starts of one handoff give one run, one invoice, one email", "conc",
          [fixture_quote("conc"), start("{{step1.id}}", concurrency=4)],
          runs(1, eq("status", "completed"), eq("billing_invoices_created", 1), eq("welcome_emails_sent", 1))),
    check("email_response_loss", "Welcome email accepted but its response lost: uncertain, resolved with the same "
          "Idempotency-Key, exactly one email", "loss",
          [fixture_quote("loss"), start("{{step1.id}}")],
          runs(1, eq("status", "completed"), eq("welcome_emails_sent", 1),
               step("welcome_email", "verified", resolved_from_uncertain=True), eq("uncertain_events", 1)),
          fault={"provider": "resend", "scenario": "accepted_response_loss", "evidence": "accepted_response_retry"},
          deadline=60),
    refusal_then_recovery("crm_auth_failure", "HubSpot 401: CRM step fails, nothing billed or sent; retry after recovery completes",
                          "h401", "hubspot", "auth_failure", "crm_lifecycle", ["billing_invoice", "welcome_email"]),
    refusal_then_recovery("crm_rate_limited", "HubSpot 429 (Retry-After honoured, then fails): nothing billed or sent; retry completes",
                          "h429", "hubspot", "rate_limited", "crm_lifecycle", ["billing_invoice", "welcome_email"]),
    refusal_then_recovery("crm_scope_denied", "HubSpot write scope missing (403): nothing billed or sent; retry completes",
                          "hscope", "hubspot", "scope_denied", "crm_lifecycle", ["billing_invoice", "welcome_email"]),
    refusal_then_recovery("billing_auth_failure", "Stripe 401: no invoice, no email; retry completes with one invoice",
                          "s401", "stripe", "auth_failure", "billing_invoice", ["welcome_email"]),
    refusal_then_recovery("billing_rate_limited", "Stripe 429: no email; retry completes with one invoice",
                          "s429", "stripe", "rate_limited", "billing_invoice", ["welcome_email"]),
    refusal_then_recovery("billing_server_error", "Stripe 503: no email; retry completes with one invoice",
                          "s503", "stripe", "recovery_server_error", "billing_invoice", ["welcome_email"]),
    refusal_then_recovery("email_auth_failure", "Resend 401: email step fails visibly; retry completes with one email",
                          "r401", "resend", "auth_failure", "welcome_email", []),
    refusal_then_recovery("email_rate_limited", "Resend 429: email step fails visibly; retry completes with one email",
                          "r429", "resend", "rate_limited", "welcome_email", []),
    refusal_then_recovery("email_server_error", "Resend 503: email step fails visibly; retry completes with one email",
                          "r503", "resend", "recovery_server_error", "welcome_email", []),
    check("contain_billing", "Contained billing agent is blocked before Stripe; release + retry completes once", "cont",
          [post("/agents/billing/contain"), fixture_quote("cont"), start("{{step2.id}}"),
           post("/agents/billing/release"), post("/handoff/runs/{{step3.id}}/retry")],
          runs(1, eq("status", "completed"), eq("first_failure.step", "billing_invoice"),
               eq("first_failure.outcome", "blocked"), eq("billing_invoices_created", 1), eq("welcome_emails_sent", 1))),
    check("restart_between_quote_and_handoff", "A sent quote survives an app restart and hands off exactly once", "rs",
          [fixture_quote("rs"),
           {"client_lifecycle": {"operation": "restart", "observe_path": "/verifier/runtime",
                                 "identity_field": "instance_id", "timeout_seconds": 180}},
           start("{{step1.id}}")],
          runs(1, eq("status", "completed"), eq("billing_invoices_created", 1), eq("welcome_emails_sent", 1)),
          deadline=60),
    check("research_is_read_only", "Research brief reads only allowlisted fields and writes nothing", "res",
          [inbound("res", "Hi, can we get a quote for 25 seats of Pro?"),
           {"method": "POST", "path": "/research/briefs", "expect_status": 200,
            "body": {"customer_email": who("res"), "requested_by": "fetchsandbox"}}],
          {"all_of": [EMPTY, {"select": "research[*]", "count": 1, "required": True,
                              "where": [eq("email_in_fields_read", False), eq("crm_writes_refused", 0),
                                        eq("written_by", "rules")]}]}),
    check("pause_holds_after_retry", "A paused run starts no new step, even after the blocked step is retried",
          "ph",
          [post("/agents/billing/contain"), fixture_quote("ph"), start("{{step2.id}}"),
           post("/handoff/runs/{{step3.id}}/pause"), post("/agents/billing/release"),
           post("/handoff/runs/{{step3.id}}/retry")],
          runs(1, eq("status", "paused"), step("crm_lifecycle", "verified"), step("billing_invoice", "pending"),
               step("welcome_email", "pending"), eq("billing_invoices_created", 0), eq("welcome_emails_sent", 0))),
    check("resume_completes_once", "Resuming the held run finishes it with one invoice and one email", "pr",
          [post("/agents/billing/contain"), fixture_quote("pr"), start("{{step2.id}}"),
           post("/handoff/runs/{{step3.id}}/pause"), post("/agents/billing/release"),
           post("/handoff/runs/{{step3.id}}/retry"), post("/handoff/runs/{{step3.id}}/resume")],
          runs(1, eq("status", "completed"), eq("billing_invoices_created", 1), eq("welcome_emails_sent", 1),
               *ALL_VERIFIED)),
]

# refusal_then_recovery also states where the run stopped while the fault was active. The run's first_failure
# record (kept in saved state) carries that, so the stopped-state rows are informational only.
for c in checks:
    c.pop("_stopped", None)

DIM = {
    "baseline": ("relevant", "handoff/workflow.py start -> crm/billing/messaging with read-back verify.", ["baseline"]),
    "identity_and_access": ("relevant", "Quote ownership is fixed at quote time; only the sent quote can be handed off. "
                            "Bearer auth on /handoff is unit-tested (the relay test app runs without it).",
                            ["pending_approval_refused", "superseded_refused"]),
    "schema_and_value_boundaries": ("relevant", "Quote status gate in HandoffWorkflow.start.",
                                    ["pending_approval_refused", "superseded_refused"]),
    "amount_currency_quantity": ("relevant", "Invoice total must equal the sent quote total (BillingAgent.verify).",
                                 ["baseline", "approved_discount_is_billed"]),
    "duplicate_replay": ("relevant", "handoff_runs.quote_id UNIQUE; find-before-create in BillingAgent; Resend Idempotency-Key.",
                         ["repeat_start", "email_response_loss"]),
    "concurrency": ("relevant", "INSERT ... ON CONFLICT (quote_id) DO NOTHING; conditional step claims.", ["concurrent_start"]),
    "ordering_and_stale_events": ("relevant", "Steps run strictly in order; each waits for the previous step's verified read-back.",
                                  ["crm_auth_failure", "billing_auth_failure"]),
    "delayed_or_missing_events": ("not_applicable", "The handoff consumes no provider webhooks; every effect is read back synchronously.", []),
    "provider_auth_and_scopes": ("relevant", "Provider 401/403 fail the step visibly and stop later steps.",
                                 ["crm_auth_failure", "crm_scope_denied", "billing_auth_failure", "email_auth_failure"]),
    "rate_limit_server_error_timeout": ("relevant", "429 retried per Retry-After then failed; 5xx failed (Stripe) or retried with the same key (Resend).",
                                        ["crm_rate_limited", "billing_rate_limited", "billing_server_error",
                                         "email_rate_limited", "email_server_error"]),
    "accepted_effect_response_loss": ("relevant", "Ambiguous transport errors -> step uncertain -> repeat the idempotent action -> verify.",
                                      ["email_response_loss"]),
    "partial_effects_and_recovery": ("relevant", "A failed step keeps its partial effects; retry reuses them (draft invoice, customer).",
                                     ["billing_server_error", "billing_auth_failure", "contain_billing"]),
    "restart_and_durability": ("relevant", "Quotes, runs, steps and the action log are in the database.",
                               ["restart_between_quote_and_handoff"]),
    "reconciliation": ("relevant", "Uncertain steps are reconciled against provider state before anything repeats.",
                       ["email_response_loss"]),
    "cancellation_refund_entitlements": ("relevant", "Contain blocks an agent's next action; pause holds a run until resume.",
                                         ["contain_billing", "pause_holds_after_retry", "resume_completes_once"]),
    "data_and_privacy_boundaries": ("relevant", "Research agent is read-only and reads only allowlisted fields.",
                                    ["research_is_read_only"]),
    "cleanup_and_isolation": ("relevant", "Every check uses {{run_id}}-scoped customers.", ["baseline"]),
}
coverage = [{"dimension": d, "relevance": r, "reason": w, "rule_ids": i} for d, (r, w, i) in DIM.items()]
EV = ["quote_agent/handoff/workflow.py", "quote_agent/handoff/agents.py", "quote_agent/handoff/gateway.py",
      "quote_agent/verifier.py handoff observer"]
scope = [{"check_id": c["id"], "classification": "in_scope", "reason": c["name"], "evidence": EV} for c in checks]
assert len(checks) <= 30
cfg = {"app_version": "quote-agent-handoff@1", "disposable_test_app": True, "require_verifier_token": True,
       "observation_seconds": 1, "checks": checks, "coverage_review": coverage, "scope_review": scope}
print(json.dumps({"session_id": SESSION, "suite": "application_workflow_v1", "application_config": cfg}))
