"""Local HTTP server for the workflow.

  POST /run               process the inbox now
  POST /gmail/push/<token> Gmail Pub/Sub push endpoint (real-time trigger);
                          /gmail/push?token= and a Bearer header also work
  GET  /processed         what the workflow has done, per Gmail message
  GET  /health
"""

from __future__ import annotations

import logging
import os
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request

from subwatch.config import load_settings
from subwatch.http import ProviderError
from subwatch.service import describe_push, push_authorized, push_token, run
from subwatch.store import make_store

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("subwatch")

settings = load_settings()
store = make_store(settings.state_backend, settings.sqlite_path, settings.dynamodb_table)
app = FastAPI(title="subscription-watch")

if os.environ.get("SUBWATCH_TEST_ADAPTER") == "1" and os.environ.get("SUBWATCH_VERIFIER_TOKEN"):
    from subwatch.test_adapter import build_router

    app.include_router(build_router(settings, store, os.environ["SUBWATCH_VERIFIER_TOKEN"]))
    log.warning("TEST ADAPTER ENABLED: /test/* routes are mounted")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/run")
def run_now() -> dict[str, Any]:
    try:
        return run(settings, store)
    except ProviderError as exc:
        raise HTTPException(502, str(exc)) from exc


@app.post("/gmail/push")
@app.post("/gmail/push/{path_token}")
async def gmail_push(request: Request, path_token: str | None = None, token: str | None = None,
                     authorization: str | None = Header(default=None)) -> dict[str, Any]:
    if not push_authorized(settings, push_token(path_token, token, authorization)):
        raise HTTPException(403, "bad push token")
    log.info("gmail push: %s", describe_push(await request.body()))
    try:
        return run(settings, store)
    except ProviderError as exc:
        # Non-2xx makes Pub/Sub redeliver later, which is what we want.
        raise HTTPException(502, str(exc)) from exc


@app.get("/processed")
def processed(limit: int = 100) -> dict[str, Any]:
    records = store.all(limit)
    return {"records": records, "count": len(records)}
