"""Process entry points (one container image, several roles):

    python -m quote_agent api               HTTP server (webhooks, inspection)
    python -m quote_agent agentcore         Amazon Bedrock AgentCore Runtime server (0.0.0.0:8080, /invocations, /ping)
    python -m quote_agent worker            SQS job consumer
    python -m quote_agent migrate           apply database migrations, then exit
    python -m quote_agent gmail-watch       renew the Gmail push watch (schedule daily)
    python -m quote_agent reap-stale-runs   fail runs left 'running' by a dead worker, and mark interrupted
                                            handoff steps uncertain (schedule every 5 min)
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
    parser.add_argument("command", choices=["api", "worker", "agentcore", "migrate", "gmail-watch", "reap-stale-runs"])
    args = parser.parse_args(argv)

    loaded: list[str] = []
    if args.command == "agentcore":
        # Credentials come from Secrets Manager (APP_SECRET_ARN) before settings are read.
        from .agentcore import load_secrets_from_aws
        loaded = load_secrets_from_aws()
    s = Settings.from_env()
    logging_setup.configure(s.log_format, service=f"quote-agent-{args.command}", level=os.environ.get("LOG_LEVEL", "INFO"))
    if loaded:
        log.info("loaded %d setting(s) from Secrets Manager", len(loaded))
    try:
        s.validate(role={"api": "api", "worker": "worker", "agentcore": "agentcore"}.get(args.command, "job"))
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
    if args.command == "agentcore":
        from .agentcore import build_agentcore_app
        from .jobs import build_queue
        # build_orchestrator already migrated when AUTO_MIGRATE=true (advisory-locked, safe across microVMs).
        build_queue(s, orch)  # inline: handoff steps run inside the invocation; sqs: queued for workers
        app = build_agentcore_app(orch, operator_actions=s.agentcore_operator_actions)
        app.run(port=8080, host="0.0.0.0")  # the AgentCore HTTP contract: fixed port 8080  # nosec B104
        return 0
    if args.command == "worker":
        if s.queue_backend != "sqs":
            log.error("the worker needs QUEUE_BACKEND=sqs (inline mode runs jobs inside the api)")
            return 2
        from .jobs import build_queue
        from .worker import Worker
        build_queue(s, orch)  # lets handoff steps queue the next agent's job
        Worker(orch, s).run_forever()
        return 0
    if args.command == "gmail-watch":
        from .jobs import gmail_watch
        gmail_watch(orch, s)
        return 0
    if args.command == "reap-stale-runs":
        reaped = orch.reap_stale_runs(s.stale_run_seconds)
        log.info("reaped %d stale run(s): %s", len(reaped), reaped)
        if orch.handoff is not None:
            uncertain = orch.handoff.reap_stale(s.stale_run_seconds)
            log.info("marked %d interrupted handoff step(s) uncertain: %s", len(uncertain), uncertain)
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
