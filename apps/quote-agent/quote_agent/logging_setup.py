"""Logging: JSON lines in AWS (CloudWatch Logs Insights can query fields), text locally."""

import contextvars
import json
import logging
import sys
from datetime import datetime, timezone

request_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("request_id", default=None)


class JsonFormatter(logging.Formatter):
    def __init__(self, service: str):
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "ts": datetime.fromtimestamp(record.created, timezone.utc).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
            "service": self.service,
            "msg": record.getMessage(),
        }
        if (rid := request_id.get()) is not None:
            entry["request_id"] = rid
        if record.exc_info:
            entry["exc"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str)


def configure(fmt: str = "text", service: str = "quote-agent", level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter(service) if fmt == "json"
                         else logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level)
    # Provider request lines include full URLs; keep them out of production logs.
    logging.getLogger("httpx").setLevel(logging.WARNING if fmt == "json" else logging.INFO)
