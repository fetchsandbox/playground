"""Local development entry point: `uvicorn main:app --reload`.

Containers use `python -m quote_agent api|worker|migrate|...` instead.
"""

import logging
import os

from quote_agent import logging_setup
from quote_agent.app import create_app

logging_setup.configure(os.environ.get("LOG_FORMAT", "text"))
logging.getLogger(__name__).info("starting quote agent (development)")

app = create_app()
