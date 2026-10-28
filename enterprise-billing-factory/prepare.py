"""Prepare proposals from a synthetic evidence bundle; never grants a verdict."""
from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def prepare(bundle):
    if bundle.get("synthetic") is not True:
        raise ValueError("This preparation tool accepts explicitly synthetic fixtures only")
    policies = {p["id"]: p for p in bundle["policies"]}
    if "POL-PAY-001" not in policies:
        raise ValueError("Missing business policy; incidents alone cannot define correctness")
    groups = defaultdict(dict)
    for event in bundle["payment_audit"]:
        if event["status"] != "succeeded":
            continue
        key = (event["tenant_id"], event["invoice_id"], event["installment"])
        existing = groups[key].get(event["payment_id"])
        # Re-delivery is harmless only if the same effect identity has the same values.
        if existing and any(existing[k] != event[k] for k in ("currency", "amount_minor")):
            raise ValueError("Conflicting payment evidence; requires investigation")
        groups[key][event["payment_id"]] = event
    findings = []
    for (tenant, invoice, installment), effects in sorted(groups.items()):
        if len(effects) <= 1:
            continue
        traces = {e["trace_id"] for e in effects.values()}
        findings.append({
            "kind": "multiple_successful_effects",
            "tenant_id": tenant, "invoice_id": invoice, "installment": installment,
            "payment_ids": sorted(effects),
            "source_ids": sorted({e["id"] for e in effects.values()} |
                                 {x["id"] for x in bundle["issues"] if x.get("trace_id") in traces} |
                                 {x["id"] for x in bundle["worker_events"] if x["trace_id"] in traces}),
            "cause": "unconfirmed; worker recovery sequence is a hypothesis to exercise"
        })
    result = {
        "schema_version": 1, "synthetic": True,
        "status": "awaiting_rule_review", "source_sha256": digest(bundle),
        "findings": findings,
        "rule_proposal": {
            "id": "RULE-COLLECTION-ONCE", "version": 1,
            "policy_source": {"id": "POL-PAY-001", "sha256": digest(policies["POL-PAY-001"])},
            "owner": "Finance Operations", "reviewer": None,
            "scope": ["tenant_id", "invoice_id", "installment"],
            "expected": "at most one successful payment per collection obligation",
            "must_also_check": "a valid collection eventually creates one successful payment",
        },
        "sandbox_plan": {
            "services": [s["id"] for s in bundle["services"]],
            "state": "isolated PostgreSQL, separate billing and payment observations",
            "controls": ["fixed seed data", "explicit event ordering", "controlled worker termination", "independent state read-back"],
            "scenarios": ["baseline_collection", "duplicate_delivery", "concurrent_delivery", "restart_after_payment_before_ack", "accepted_payment_response_lost", "tenant_isolation", "distinct_installments"],
            "reset": "new namespace per revision and scenario; never share effect history",
            "not_proven": ["provider fidelity", "production concurrency", "AWS deployment", "native agent behavior"],
        },
        "release": {"risk": "high", "status": "blocked_unverified", "approved_artifact": None},
    }
    result["proposal_sha256"] = digest(result)
    return result


def verify_integrity(plan, bundle):
    unsigned = {k: v for k, v in plan.items() if k != "proposal_sha256"}
    return plan.get("source_sha256") == digest(bundle) and plan.get("proposal_sha256") == digest(unsigned)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    plan = prepare(json.loads((ROOT / "fixtures/signals.json").read_text()))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(plan, indent=2) + "\n")
    print(json.dumps({"status": plan["status"], "findings": len(plan["findings"]), "output": str(args.out)}))
