"""The one door every agent action goes through.

Each agent declares a manifest: who owns it, which actions it may perform and
which systems it touches. Before an agent acts, the gateway checks the action
against that manifest and whether the agent is contained, and it records what
happened in the append-only action log, keyed by a hash of the exact payload.

Today the decision is a local allowlist. This class is the seam where an
external checkpoint (for example LoopLabs) takes over the decision; the agents
do not change when it does. GET /agents serves the manifests so such a
checkpoint can discover the agents.
"""

import hashlib
import json
from dataclasses import asdict, dataclass, field
from typing import Any, Callable

import httpx

from ..store import Store
from .store import HandoffStore

# Transport errors after the request may already have reached the provider:
# the effect is unknown, so the step is uncertain rather than failed.
AMBIGUOUS_TRANSPORT_ERRORS = (httpx.ReadTimeout, httpx.WriteTimeout, httpx.ReadError, httpx.WriteError,
                              httpx.RemoteProtocolError)


class ActionBlocked(RuntimeError):
    pass


class ResponseLost(RuntimeError):
    """The request was sent but no response came back: the effect may or may not exist."""


@dataclass(frozen=True)
class AgentSpec:
    name: str
    title: str
    purpose: str
    actions: tuple[str, ...]
    systems: tuple[str, ...]
    credential: str  # the env var holding this agent's own provider credential
    read_only: bool = False
    customer_facing: bool = False
    owner: str = "unassigned"


MANIFESTS: dict[str, AgentSpec] = {s.name: s for s in [
    AgentSpec("quote", "Quote agent", "Quotes and discounts from customer email and Slack",
              ("quote.send", "discount.apply", "discount.request_approval", "crm.record_deal"),
              ("gmail", "slack", "hubspot", "claude"), "HUBSPOT_ACCESS_TOKEN", customer_facing=True),
    AgentSpec("research", "Account research agent", "Read-only account brief for a rep",
              ("crm.read_contact", "model.summarize"), ("hubspot:read", "claude"), "RESEARCH_HUBSPOT_TOKEN",
              read_only=True),
    AgentSpec("crm", "CRM agent", "Marks a won customer in the CRM",
              ("crm.set_lifecycle_stage",), ("hubspot",), "HANDOFF_HUBSPOT_TOKEN"),
    AgentSpec("billing", "Billing agent", "Issues the invoice for the accepted quote",
              ("billing.issue_invoice",), ("stripe",), "STRIPE_SECRET_KEY"),
    AgentSpec("messaging", "Messaging agent", "Sends the customer their welcome email",
              ("email.send_welcome",), ("resend",), "RESEND_API_KEY", customer_facing=True),
]}


def payload_hash(payload: Any) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()


@dataclass
class Decision:
    allowed: bool
    reason: str
    decided_by: str = "local-allowlist"


@dataclass
class ActionGateway:
    store: Store
    log: HandoffStore
    owners: dict[str, str] = field(default_factory=dict)

    def manifest(self, name: str) -> AgentSpec:
        spec = MANIFESTS[name]
        return AgentSpec(**{**asdict(spec), "owner": self.owners.get(name, spec.owner)})

    def manifests(self) -> list[dict[str, Any]]:
        return [{**asdict(self.manifest(n)), "contained": self.is_contained(n)} for n in MANIFESTS]

    # --- containment (the stop button) --------------------------------------

    def is_contained(self, agent: str) -> bool:
        return self.store.get_kv(f"contained:{agent}") == "1"

    def set_contained(self, agent: str, contained: bool, by: str) -> None:
        if agent not in MANIFESTS:
            raise KeyError(agent)
        self.store.set_kv(f"contained:{agent}", "1" if contained else "0")
        self.record(agent, "agent.contain" if contained else "agent.release", {"agent": agent},
                    "contained" if contained else "released", {"by": by})

    # --- decisions and the log ----------------------------------------------

    def authorize(self, agent: str, action: str, payload: dict[str, Any]) -> Decision:
        spec = MANIFESTS.get(agent)
        if spec is None:
            return Decision(False, f"unknown agent {agent!r}")
        if action not in spec.actions:
            return Decision(False, f"{agent} is not allowed to {action}")
        if self.is_contained(agent):
            return Decision(False, f"{agent} is contained")
        return Decision(True, "action is in the agent's allowlist")

    def record(self, agent: str, action: str, payload: Any, outcome: str, detail: dict | None = None,
               run_id: str | None = None, step: str | None = None) -> dict[str, Any]:
        return self.log.append_action(agent=agent, action=action, outcome=outcome, payload_hash=payload_hash(payload),
                                      detail=detail, run_id=run_id, step=step)

    def perform(self, agent: str, action: str, payload: dict[str, Any], execute: Callable[[], Any], *,
                run_id: str | None = None, step: str | None = None) -> Any:
        """Authorize, execute and record one action. Raises ActionBlocked / ResponseLost / the provider error."""
        decision = self.authorize(agent, action, payload)
        self.record(agent, action, payload, "allowed" if decision.allowed else "blocked",
                    {"reason": decision.reason, "decided_by": decision.decided_by}, run_id, step)
        if not decision.allowed:
            raise ActionBlocked(decision.reason)
        try:
            result = execute()
        except AMBIGUOUS_TRANSPORT_ERRORS as exc:
            self.record(agent, action, payload, "uncertain", {"error": f"{type(exc).__name__}: {exc}"}, run_id, step)
            raise ResponseLost(f"{type(exc).__name__}: no response from the provider") from exc
        except Exception as exc:
            self.record(agent, action, payload, "failed", {"error": f"{type(exc).__name__}: {exc}"[:500]}, run_id, step)
            raise
        self.record(agent, action, payload, "executed", None, run_id, step)
        return result
