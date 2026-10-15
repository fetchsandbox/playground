"""Settings, read once from the environment. See .env.example."""

import json
import os
from dataclasses import dataclass, field
from decimal import Decimal


def _csv(name: str) -> list[str]:
    return [v.strip() for v in os.environ.get(name, "").split(",") if v.strip()]


def _bool(name: str, default: bool = False) -> bool:
    return os.environ.get(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class Settings:
    db_path: str = "quote_agent.db"

    # Intent classification
    anthropic_api_key: str | None = None
    classifier_model: str = "claude-opus-5-5"
    classifier: str = "auto"  # auto | claude | rules
    min_confidence: float = 0.6

    # Discount policy
    approval_threshold_pct: Decimal = Decimal("20")
    decline_above_pct: Decimal = Decimal("70")

    # HubSpot
    hubspot_base_url: str = "https://api.hubapi.com"
    hubspot_token: str = ""
    hubspot_deal_stage: str = "presentationscheduled"
    hubspot_pipeline: str = "default"
    hubspot_record_deals: bool = True

    # Pricing service: empty = use the in-process catalog
    pricing_service_url: str = ""

    # Slack
    slack_base_url: str = "https://slack.com/api"
    slack_bot_token: str = ""
    slack_signing_secret: str = ""
    slack_manager_channel: str = ""  # channel or user id that receives approvals
    slack_manager_user_ids: list[str] = field(default_factory=list)
    slack_intake_channels: list[str] = field(default_factory=list)  # empty = DMs + mentions only

    # Gmail
    gmail_base_url: str = "https://gmail.googleapis.com/gmail/v1"
    gmail_token_url: str = "https://oauth2.googleapis.com/token"
    gmail_address: str = ""
    gmail_access_token: str = ""
    gmail_client_id: str = ""
    gmail_client_secret: str = ""
    gmail_refresh_token: str = ""
    gmail_push_token: str = ""  # shared secret on the Pub/Sub push URL

    quote_valid_days: int = 30
    company_name: str = "Northwind"
    dev_endpoints: bool = False
    verifier_token: str = ""  # enables the read-only /verifier test adapter
    admin_token: str = ""  # enables /runs and /quotes (Bearer); unset = disabled
    provider_headers: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_env(cls) -> "Settings":
        e = os.environ.get
        return cls(
            db_path=e("QUOTE_AGENT_DB", "quote_agent.db"),
            anthropic_api_key=e("ANTHROPIC_API_KEY"),
            classifier_model=e("CLASSIFIER_MODEL", "claude-opus-5-5"),
            classifier=e("CLASSIFIER", "auto"),
            min_confidence=float(e("CLASSIFIER_MIN_CONFIDENCE", "0.6")),
            approval_threshold_pct=Decimal(e("DISCOUNT_APPROVAL_THRESHOLD_PCT", "20")),
            decline_above_pct=Decimal(e("DISCOUNT_DECLINE_ABOVE_PCT", "70")),
            hubspot_base_url=e("HUBSPOT_BASE_URL", "https://api.hubapi.com"),
            hubspot_token=e("HUBSPOT_ACCESS_TOKEN", ""),
            hubspot_deal_stage=e("HUBSPOT_DEAL_STAGE", "presentationscheduled"),
            hubspot_pipeline=e("HUBSPOT_PIPELINE", "default"),
            hubspot_record_deals=_bool("HUBSPOT_RECORD_DEALS", True),
            pricing_service_url=e("PRICING_SERVICE_URL", ""),
            slack_base_url=e("SLACK_BASE_URL", "https://slack.com/api"),
            slack_bot_token=e("SLACK_BOT_TOKEN", ""),
            slack_signing_secret=e("SLACK_SIGNING_SECRET", ""),
            slack_manager_channel=e("SLACK_MANAGER_CHANNEL", ""),
            slack_manager_user_ids=_csv("SLACK_MANAGER_USER_IDS"),
            slack_intake_channels=_csv("SLACK_INTAKE_CHANNELS"),
            gmail_base_url=e("GMAIL_BASE_URL", "https://gmail.googleapis.com/gmail/v1"),
            gmail_token_url=e("GMAIL_TOKEN_URL", "https://oauth2.googleapis.com/token"),
            gmail_address=e("GMAIL_ADDRESS", ""),
            gmail_access_token=e("GMAIL_ACCESS_TOKEN", ""),
            gmail_client_id=e("GMAIL_CLIENT_ID", ""),
            gmail_client_secret=e("GMAIL_CLIENT_SECRET", ""),
            gmail_refresh_token=e("GMAIL_REFRESH_TOKEN", ""),
            gmail_push_token=e("GMAIL_PUSH_TOKEN", ""),
            quote_valid_days=int(e("QUOTE_VALID_DAYS", "30")),
            company_name=e("COMPANY_NAME", "Northwind"),
            dev_endpoints=_bool("DEV_ENDPOINTS"),
            verifier_token=e("QUOTE_AGENT_VERIFIER_TOKEN", ""),
            admin_token=e("QUOTE_AGENT_ADMIN_TOKEN", ""),
            provider_headers=json.loads(e("QUOTE_AGENT_PROVIDER_HEADERS", "") or "{}"),
        )
