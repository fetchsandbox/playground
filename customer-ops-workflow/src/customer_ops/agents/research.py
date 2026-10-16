"""Research agent — company / contact enrichment."""

from __future__ import annotations

from customer_ops.agents.base import AgentContext
from customer_ops.models import AgentName, AgentResult, AgentStatus


class ResearchAgent:
    name = AgentName.RESEARCH

    def run(self, ctx: AgentContext) -> AgentResult:
        req = ctx.workflow.request
        company = req.company or _guess_company(req.customer_email)
        domain = req.customer_email.split("@")[-1].lower()
        # Deterministic "research" enrichment for local/demo; swap for Clearbit/etc.
        profile = {
            "company": company,
            "domain": domain,
            "segment": "mid-market" if domain.endswith(".com") else "other",
            "employee_band": "51-200",
            "signals": [
                f"Inbound quote request for {req.sku}",
                f"Contact {req.customer_name or req.customer_email}",
            ],
            "recommended_sku": req.sku,
            "confidence": 0.82,
        }
        return AgentResult(agent=self.name, status=AgentStatus.SUCCEEDED).succeed(profile)


def _guess_company(email: str) -> str:
    domain = email.split("@")[-1]
    root = domain.split(".")[0]
    return root.replace("-", " ").title()
