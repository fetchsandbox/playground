"""Settings, read once from the environment. See .env.example."""

import json
import os
from dataclasses import dataclass, field
from decimal import Decimal


def _csv(name: str) -> list[str]:
    return [v.strip() for v in os.environ.get(name, "").split(",") if v.strip()]


def _bool(name: str, default: bool = False) -> bool:
    return os.environ.get(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


class ConfigError(ValueError):
    pass


@dataclass
class Settings:
    environment: str = "development"  # development | staging | production
    db_path: str = "quote_agent.db"  # SQLite file, used when no Postgres settings are given
    database_url: str = ""  # postgresql://... (or set DB_HOST/DB_NAME/DB_USER/DB_PASSWORD)
    auto_migrate: bool = True  # production runs the `migrate` task instead

    # Background jobs
    queue_backend: str = "inline"  # inline (same process) | sqs
    sqs_queue_url: str = ""
    aws_region: str = ""
    stale_run_seconds: int = 900  # a run 'running' longer than this is reaped as failed

    log_format: str = "text"  # text | json

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
    gmail_pubsub_topic: str = ""  # projects/<p>/topics/<t>, used by the gmail-watch job

    # Customer handoff (CRM -> billing -> welcome email). Each agent has its own credential.
    handoff_hubspot_token: str = ""  # CRM agent; defaults to HUBSPOT_ACCESS_TOKEN
    stripe_base_url: str = "https://api.stripe.com"
    stripe_secret_key: str = ""  # billing agent
    resend_base_url: str = "https://api.resend.com"
    resend_api_key: str = ""  # messaging agent
    handoff_from_email: str = ""
    handoff_account_team: str = "your Northwind account team"
    invoice_days_until_due: int = 30
    handoff_api_token: str = ""  # Bearer for /handoff, /agents, /actions, /research; unset = disabled
    handoff_auto_reconcile: bool = True  # resolve an uncertain step straight away
    agent_owners: dict[str, str] = field(default_factory=dict)  # {"billing": "finance-ops@..."}
    agent_queue_urls: dict[str, str] = field(default_factory=dict)  # {"billing": "https://sqs..."}; else SQS_QUEUE_URL
    research_hubspot_token: str = ""  # research agent (read-only); defaults to HUBSPOT_ACCESS_TOKEN
    research_allowed_fields: list[str] = field(default_factory=list)  # empty = the built-in allowlist
    provider_timeout_seconds: float = 20.0
    agentcore_operator_actions: bool = False  # AgentCore operator runtime only (see agentcore.py)

    quote_valid_days: int = 30
    company_name: str = "Northwind"
    dev_endpoints: bool = False
    verifier_token: str = ""  # enables the read-only /verifier test adapter
    admin_token: str = ""  # enables /runs and /quotes (Bearer); unset = disabled
    provider_headers: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_env(cls) -> "Settings":
        e = os.environ.get
        db_url = e("DATABASE_URL", "")
        if not db_url and e("DB_HOST"):
            from urllib.parse import quote
            db_url = (f"postgresql://{quote(e('DB_USER', ''), safe='')}:{quote(e('DB_PASSWORD', ''), safe='')}"
                      f"@{e('DB_HOST')}:{e('DB_PORT', '5432')}/{e('DB_NAME', 'quote_agent')}"
                      f"?sslmode={e('DB_SSLMODE', 'require')}")
        environment = e("ENVIRONMENT", "development")
        return cls(
            environment=environment,
            db_path=e("QUOTE_AGENT_DB", "quote_agent.db"),
            database_url=db_url,
            auto_migrate=_bool("AUTO_MIGRATE", environment == "development"),
            queue_backend=e("QUEUE_BACKEND", "inline"),
            sqs_queue_url=e("SQS_QUEUE_URL", ""),
            aws_region=e("AWS_REGION", e("AWS_DEFAULT_REGION", "")),
            stale_run_seconds=int(e("STALE_RUN_SECONDS", "900")),
            log_format=e("LOG_FORMAT", "json" if environment != "development" else "text"),
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
            gmail_pubsub_topic=e("GMAIL_PUBSUB_TOPIC", ""),
            handoff_hubspot_token=e("HANDOFF_HUBSPOT_TOKEN", ""),
            stripe_base_url=e("STRIPE_BASE_URL", "https://api.stripe.com"),
            stripe_secret_key=e("STRIPE_SECRET_KEY", ""),
            resend_base_url=e("RESEND_BASE_URL", "https://api.resend.com"),
            resend_api_key=e("RESEND_API_KEY", ""),
            handoff_from_email=e("HANDOFF_FROM_EMAIL", ""),
            handoff_account_team=e("HANDOFF_ACCOUNT_TEAM", "your Northwind account team"),
            invoice_days_until_due=int(e("INVOICE_DAYS_UNTIL_DUE", "30")),
            handoff_api_token=e("HANDOFF_API_TOKEN", ""),
            handoff_auto_reconcile=_bool("HANDOFF_AUTO_RECONCILE", True),
            agent_owners=json.loads(e("AGENT_OWNERS", "") or "{}"),
            agent_queue_urls=json.loads(e("AGENT_QUEUE_URLS", "") or "{}"),
            research_hubspot_token=e("RESEARCH_HUBSPOT_TOKEN", ""),
            research_allowed_fields=_csv("RESEARCH_ALLOWED_FIELDS"),
            provider_timeout_seconds=float(e("PROVIDER_TIMEOUT_SECONDS", "20")),
            agentcore_operator_actions=_bool("AGENTCORE_OPERATOR_ACTIONS"),
            quote_valid_days=int(e("QUOTE_VALID_DAYS", "30")),
            company_name=e("COMPANY_NAME", "Northwind"),
            dev_endpoints=_bool("DEV_ENDPOINTS"),
            verifier_token=e("QUOTE_AGENT_VERIFIER_TOKEN", ""),
            admin_token=e("QUOTE_AGENT_ADMIN_TOKEN", ""),
            provider_headers=json.loads(e("QUOTE_AGENT_PROVIDER_HEADERS", "") or "{}"),
        )

    @property
    def db_url(self) -> str:
        return self.database_url or self.db_path

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    def validate(self, role: str = "api") -> None:
        """Fail fast on configuration that is unsafe or unusable. role: api | worker | agentcore | job."""
        problems: list[str] = []
        if self.environment not in {"development", "staging", "production"}:
            problems.append(f"ENVIRONMENT must be development, staging or production, not {self.environment!r}")
        if self.queue_backend not in {"inline", "sqs"}:
            problems.append("QUEUE_BACKEND must be inline or sqs")
        if self.queue_backend == "sqs" and not self.sqs_queue_url:
            problems.append("QUEUE_BACKEND=sqs needs SQS_QUEUE_URL")
        if self.environment != "development":
            if not self.database_url:
                problems.append("a non-development environment needs PostgreSQL (DATABASE_URL or DB_HOST/...)")
            # AgentCore runs handoff steps inside the invocation, so inline is allowed there.
            if self.queue_backend != "sqs" and role != "agentcore":
                problems.append("a non-development environment needs QUEUE_BACKEND=sqs")
        if self.is_production:
            if self.dev_endpoints:
                problems.append("DEV_ENDPOINTS must be off in production")
            if self.verifier_token or self.provider_headers:
                problems.append("test-only verifier settings must be unset in production")
            if not self.anthropic_api_key:
                problems.append("production needs ANTHROPIC_API_KEY (the rule classifier is a dev fallback)")
        if role == "api" and self.environment != "development":
            if self.slack_bot_token and not self.slack_signing_secret:
                problems.append("Slack is configured without SLACK_SIGNING_SECRET")
            if (self.gmail_access_token or self.gmail_refresh_token) and not self.gmail_push_token:
                problems.append("Gmail is configured without GMAIL_PUSH_TOKEN")
        if self.resend_api_key and not self.handoff_from_email:
            problems.append("RESEND_API_KEY is set without HANDOFF_FROM_EMAIL")
        if self.slack_bot_token and not self.slack_manager_channel:
            problems.append("Slack is configured without SLACK_MANAGER_CHANNEL")
        if problems:
            raise ConfigError("; ".join(problems))
