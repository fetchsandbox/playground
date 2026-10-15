"""Entry point: `uvicorn main:app`."""

import logging

from quote_agent.app import create_app

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

app = create_app()
