"""Customer handoff agents built on top of the quote agent.

A sent quote is handed off by three agents in order (CRM, billing,
messaging), and a read-only research agent briefs reps. See workflow.py for
the rules and gateway.py for the control point every agent action passes.
"""

from typing import Any, Callable

import anthropic
import httpx

from ..config import Settings
from ..providers.hubspot import HubSpotClient
from ..providers.resend import ResendClient
from ..providers.stripe import StripeClient
from ..store import Store
from .agents import BillingAgent, CrmAgent, HandoffAgent, MessagingAgent
from .gateway import ActionGateway
from .research import DEFAULT_ALLOWED_FIELDS, ClaudeBriefWriter, ReadOnlyHubSpot, ResearchAgent
from .store import HandoffStore
from .workflow import HandoffWorkflow


def build_handoff(s: Settings, store: Store, *, http: httpx.Client | None = None,
                  alert: Callable[[str], Any] | None = None,
                  claude: anthropic.Anthropic | None = None) -> tuple[HandoffWorkflow, ResearchAgent]:
    http = http or httpx.Client(timeout=s.provider_timeout_seconds, headers=s.provider_headers)
    handoffs = HandoffStore(store.db)
    gateway = ActionGateway(store=store, log=handoffs, owners=s.agent_owners)

    agents: dict[str, HandoffAgent] = {}
    crm_token = s.handoff_hubspot_token or s.hubspot_token
    if crm_token:
        agents["crm"] = CrmAgent(HubSpotClient(s.hubspot_base_url, crm_token, http=http))
    if s.stripe_secret_key:
        agents["billing"] = BillingAgent(StripeClient(s.stripe_base_url, s.stripe_secret_key, http=http),
                                         s.invoice_days_until_due)
    if s.resend_api_key:
        agents["messaging"] = MessagingAgent(ResendClient(s.resend_base_url, s.resend_api_key, http=http),
                                             s.handoff_from_email, s.company_name, s.handoff_account_team)
    workflow = HandoffWorkflow(store=store, handoffs=handoffs, gateway=gateway, agents=agents,
                               auto_reconcile=s.handoff_auto_reconcile, alert=alert)

    research_token = s.research_hubspot_token or s.hubspot_token
    research = ResearchAgent(
        hubspot=ReadOnlyHubSpot(s.hubspot_base_url, research_token, http=http) if research_token else None,
        store=store, handoffs=handoffs, gateway=gateway,
        writer=ClaudeBriefWriter(claude, s.classifier_model) if claude is not None else None,
        allowed_fields=tuple(s.research_allowed_fields) or DEFAULT_ALLOWED_FIELDS,
    )
    return workflow, research
