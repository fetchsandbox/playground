"""Process entry points (one container image, several roles):

    python -m quote_agent api               HTTP server (webhooks, inspection)
    python -m quote_agent worker            SQS job consumer
    python -m quote_agent migrate           apply database migrations, then exit
    python -m quote_agent gmail-watch       renew the Gmail push watch (schedule daily)
    python -m quote_agent reap-stale-runs   fail runs left 'running' by a dead worker (schedule every 5 min)
"""

import argparse
import logging
import os
import sys

from . import logging_setup
from .config import ConfigError, Settings

log = logging.getLogger("quote_agent")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="quote_agent")
    parser.add_argument("command", choices=["api", "worker", "migrate", "gmail-watch", "reap-stale-runs"])
    args = parser.parse_args(argv)

    s = Settings.from_env()
    logging_setup.configure(s.log_format, service=f"quote-agent-{args.command}", level=os.environ.get("LOG_LEVEL", "INFO"))
    try:
        s.validate(role={"api": "api", "worker": "worker"}.get(args.command, "job"))
    except ConfigError as exc:
        log.error("invalid configuration: %s", exc)
        return 2

    if args.command == "migrate":
        from .store import Store
        applied = Store(s.db_url).migrate()
        log.info("migrations applied: %s", applied or "none pending")
        return 0

    from .app import build_orchestrator
    orch = build_orchestrator(s)

    if args.command == "api":
        import uvicorn
        from .app import create_app
        uvicorn.run(create_app(s, orch), host="0.0.0.0", port=int(os.environ.get("PORT", "8000")),
                    proxy_headers=True, forwarded_allow_ips="*", access_log=not s.is_production, log_config=None)
        return 0
    if args.command == "worker":
        if s.queue_backend != "sqs":
            log.error("the worker needs QUEUE_BACKEND=sqs (inline mode runs jobs inside the api)")
            return 2
        from .worker import Worker
        Worker(orch, s).run_forever()
        return 0
    if args.command == "gmail-watch":
        from .jobs import gmail_watch
        gmail_watch(orch, s)
        return 0
    if args.command == "reap-stale-runs":
        reaped = orch.reap_stale_runs(s.stale_run_seconds)
        log.info("reaped %d stale run(s): %s", len(reaped), reaped)
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
