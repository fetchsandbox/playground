"""The customer handoff: a won quote becomes a customer, an invoice and a welcome email.

    start(quote) ─► crm_lifecycle ─verify─► billing_invoice ─verify─► welcome_email ─verify─► completed
                    (CRM agent)             (billing agent)            (messaging agent)

Rules:
  * A step starts only after the step before it is verified by reading the
    provider back. No invoice for a contact the CRM doesn't show as a customer;
    no welcome email for an invoice that doesn't exist.
  * One run per quote, and the quote must be the sent one: a quote waiting on
    discount approval, superseded by a revision, or never sent cannot start a
    handoff. The invoice amount is the sent quote's total.
  * A step whose request was sent but whose response was lost is *uncertain*,
    never retried blindly. Resolving it acts again (each agent's act is safe to
    repeat, see agents.py) and verifies; the log keeps uncertain -> verified.
  * Pause stops new steps (also after a retry) until resume. It does not undo
    a step that already ran.
  * Contain (per agent) blocks that agent's next action; a step of that agent
    that is running at that moment is marked uncertain, not assumed undone.

Run statuses: running, paused, uncertain, blocked, failed, completed.
Step statuses: pending, running, verified, uncertain, failed.

Each step is executed by a `handoff_advance` job routed to its agent's queue,
so in AWS every agent can run as its own worker service.
"""

import logging
import uuid
from typing import Any, Callable

from ..store import Store, now_iso
from .agents import HandoffAgent, StepContext
from .gateway import ActionBlocked, ActionGateway, ResponseLost
from .store import HandoffStore

log = logging.getLogger(__name__)

STEPS = [
    {"name": "crm_lifecycle", "agent": "crm"},
    {"name": "billing_invoice", "agent": "billing"},
    {"name": "welcome_email", "agent": "messaging"},
]
TERMINAL = {"completed", "failed", "blocked"}


class HandoffError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class HandoffWorkflow:
    def __init__(self, *, store: Store, handoffs: HandoffStore, gateway: ActionGateway,
                 agents: dict[str, HandoffAgent], auto_reconcile: bool = True,
                 alert: Callable[[str], Any] | None = None):
        self.store = store
        self.handoffs = handoffs
        self.gateway = gateway
        self.agents = agents
        self.auto_reconcile = auto_reconcile
        self.alert = alert
        # Set by the job queue (jobs.build_queue). Without one, steps run in-process.
        self.enqueue: Callable[[dict[str, Any]], None] | None = None

    # ======================================================================
    # Commands
    # ======================================================================

    def start(self, quote_id: str, requested_by: str) -> tuple[dict[str, Any], bool]:
        """Start the handoff for a sent quote. Returns (run, created); a repeat returns the existing run."""
        quote = self.store.get_quote(quote_id.strip())
        if quote is None:
            raise HandoffError(404, f"quote {quote_id} not found")
        existing = self.handoffs.get_run_by_quote(quote.id)
        if existing:
            return existing, False
        if quote.status != "sent":
            reason = {"pending_approval": "is waiting on discount approval",
                      "superseded": "was replaced by a revised quote",
                      "draft": "was never sent to the customer"}.get(quote.status, f"has status {quote.status}")
            raise HandoffError(409, f"quote {quote.id} {reason}; only the sent quote can be handed off")
        run = {"id": f"HND-{uuid.uuid4().hex[:8].upper()}", "quote_id": quote.id, "status": "running",
               "requested_by": requested_by, "customer_email": quote.customer_email,
               "amount_cents": quote.total_cents, "currency": quote.currency}
        if not self.handoffs.create_run(run, STEPS):
            return self.handoffs.get_run_by_quote(quote.id), False  # lost a concurrent start
        self.gateway.record("handoff", "handoff.start", {"quote_id": quote.id, "amount_cents": quote.total_cents},
                            "started", {"requested_by": requested_by}, run["id"])
        self._schedule(run["id"])
        return self.handoffs.get_run(run["id"]), True

    def pause(self, run_id: str, by: str) -> dict[str, Any]:
        """Hold the run: no new step starts until resume, including after a retry. Allowed on a
        failed or blocked run too, so an operator can fix the cause and retry without it running on."""
        run = self._run(run_id)
        if run["status"] == "completed":
            raise HandoffError(409, f"run {run_id} is already completed")
        self.handoffs.set_paused(run_id, True)
        if run["status"] == "running":
            self.handoffs.set_run_status(run_id, "paused")
        self.gateway.record("handoff", "handoff.pause", {"run_id": run_id}, "paused",
                            {"by": by, "note": "stops new steps; does not undo steps already done"}, run_id)
        return self._run(run_id)

    def resume(self, run_id: str, by: str) -> dict[str, Any]:
        run = self._run(run_id)
        self.handoffs.set_paused(run_id, False)
        if run["status"] == "paused":
            self.handoffs.set_run_status(run_id, "running")
        self.gateway.record("handoff", "handoff.resume", {"run_id": run_id}, "resumed", {"by": by}, run_id)
        self._schedule(run_id)
        return self._run(run_id)

    def retry(self, run_id: str, by: str) -> dict[str, Any]:
        """Re-queue a failed or blocked step after its cause is fixed."""
        run = self._run(run_id)
        step = next((s for s in run["steps"] if s["status"] == "failed"), None)
        if step is None:
            raise HandoffError(409, f"run {run_id} has no failed step to retry")
        self.handoffs.move_step(run_id, step["name"], "failed", "pending", {"error": None})
        self.handoffs.set_run_status(run_id, "paused" if run["paused"] else "running")
        self.gateway.record("handoff", "handoff.retry", {"run_id": run_id, "step": step["name"]}, "retried",
                            {"by": by}, run_id, step["name"])
        self._schedule(run_id)
        return self._run(run_id)

    def verify(self, run_id: str, by: str) -> dict[str, Any]:
        """Resolve an uncertain step now, then continue if it verified."""
        run = self._run(run_id)
        step = next((s for s in run["steps"] if s["status"] == "uncertain"), None)
        if step is None:
            raise HandoffError(409, f"run {run_id} has no uncertain step")
        self.gateway.record("handoff", "handoff.verify", {"run_id": run_id, "step": step["name"]}, "requested",
                            {"by": by}, run_id, step["name"])
        if self._resolve_uncertain(run, step):
            self._schedule(run_id)
        return self._run(run_id)

    def contain(self, agent: str, by: str) -> dict[str, Any]:
        """Block an agent's next actions; mark its in-flight steps uncertain."""
        self.gateway.set_contained(agent, True, by)
        marked = []
        for row in self.handoffs.running_steps_for_agent(agent):
            if self.handoffs.move_step(row["run_id"], row["name"], "running", "uncertain",
                                       {"error": f"{agent} was contained while this step was running"}):
                self.handoffs.set_run_status(row["run_id"], "uncertain")
                marked.append(row["run_id"])
        return {"agent": agent, "contained": True, "in_flight_marked_uncertain": marked}

    def release(self, agent: str, by: str) -> dict[str, Any]:
        self.gateway.set_contained(agent, False, by)
        return {"agent": agent, "contained": False}

    def reap_stale(self, older_than_seconds: int) -> list[str]:
        """Steps left running by a dead worker become uncertain (the effect may exist)."""
        reaped = []
        for row in self.handoffs.stale_running_steps(older_than_seconds):
            if self.handoffs.move_step(row["run_id"], row["name"], "running", "uncertain",
                                       {"error": f"no progress for over {older_than_seconds}s (worker stopped mid-step)"}):
                self.handoffs.set_run_status(row["run_id"], "uncertain")
                self.gateway.record(row["agent"], "handoff.reap", {"run_id": row["run_id"], "step": row["name"]},
                                    "uncertain", {"reason": "stale running step"}, row["run_id"], row["name"])
                reaped.append(row["run_id"])
                self._alert(f":warning: Handoff {row['run_id']} step '{row['name']}' was interrupted; "
                            f"its outcome is uncertain. Verify it before anything repeats.")
        return reaped

    # ======================================================================
    # Execution
    # ======================================================================

    def advance(self, run_id: str, agent: str | None = None) -> dict[str, Any] | None:
        """Execute the next step of a run, if it may run now. Called by the handoff_advance job.

        `agent` is the agent the job was queued for. With one worker service per agent, a job
        redelivered after its step finished must not run the next agent's step here (this
        worker lacks that agent's credential); it is sent on to that agent's queue instead.
        """
        run = self.handoffs.get_run(run_id)
        if run is None:
            log.warning("handoff run %s not found", run_id)
            return None
        if run["status"] in TERMINAL or run["paused"]:
            return run
        step = next((s for s in run["steps"] if s["status"] != "verified"), None)
        if step is None:
            self.handoffs.set_run_status(run_id, "completed")
            self.gateway.record("handoff", "handoff.complete", {"run_id": run_id}, "completed", None, run_id)
            return self._run(run_id)
        if step["status"] != "pending":
            return run  # running elsewhere, uncertain or failed: nothing to start
        if agent not in (None, "handoff", step["agent"]) and self.enqueue is not None:
            self._schedule(run_id)  # belongs to another agent's worker
            return run
        if not self.handoffs.claim_step(run_id, step["name"], ("pending",)):
            return run  # another worker claimed it
        if self._execute(run, step):
            self._schedule(run_id)
        return self._run(run_id)

    def _context(self, run: dict[str, Any]) -> StepContext:
        quote = self.store.get_quote(run["quote_id"])
        effects = {s["name"]: s.get("effect") or {} for s in run["steps"] if s["status"] == "verified"}
        return StepContext(run_id=run["id"], quote=quote, effects=effects)

    def _execute(self, run: dict[str, Any], step: dict[str, Any]) -> bool:
        """Run one claimed step. True if it verified and the run should continue."""
        agent = self.agents.get(step["agent"])
        if agent is None:
            return self._fail(run, step, "running", f"the {step['agent']} agent is not configured")
        ctx = self._context(run)
        payload = agent.payload(ctx)
        try:
            effect = self.gateway.perform(agent.name, agent.action, payload, lambda: agent.act(ctx),
                                          run_id=run["id"], step=step["name"])
        except ActionBlocked as exc:
            return self._fail(run, step, "running", f"blocked: {exc}", status="blocked")
        except ResponseLost as exc:
            self.handoffs.move_step(run["id"], step["name"], "running", "uncertain", {"error": str(exc)})
            self.handoffs.set_run_status(run["id"], "uncertain", error=f"{step['name']}: {exc}")
            if not self.auto_reconcile:
                return False
            return self._resolve_uncertain(self._run(run["id"]), {**step, "status": "uncertain"})
        except Exception as exc:  # provider refused or errored: not applied, or applied in part
            return self._fail(run, step, "running", f"{type(exc).__name__}: {exc}")
        return self._check(run, step, ctx, effect, from_status="running")

    def _resolve_uncertain(self, run: dict[str, Any], step: dict[str, Any]) -> bool:
        """Act again (safe by construction) and verify. Leaves the step uncertain if the provider is unreachable."""
        if not self.handoffs.claim_step(run["id"], step["name"], ("uncertain",)):
            return False
        agent = self.agents[step["agent"]]
        ctx = self._context(run)
        payload = agent.payload(ctx)
        self.gateway.record(agent.name, agent.action, payload, "reconciling",
                            {"how": "repeat the idempotent action, then read the provider back"},
                            run["id"], step["name"])
        try:
            effect = agent.act(ctx)
            self.gateway.record(agent.name, agent.action, payload, "reconciled", effect, run["id"], step["name"])
        except Exception as exc:  # still can't tell: stays uncertain until verified later
            self.handoffs.move_step(run["id"], step["name"], "running", "uncertain",
                                    {"error": f"reconcile failed: {type(exc).__name__}: {exc}"[:500]})
            self.handoffs.set_run_status(run["id"], "uncertain")
            self.gateway.record(agent.name, agent.action, payload, "uncertain",
                                {"error": f"{type(exc).__name__}: {exc}"[:500]}, run["id"], step["name"])
            return False
        return self._check(run, step, ctx, effect, from_status="running", resolved_from_uncertain=True)

    def _check(self, run: dict[str, Any], step: dict[str, Any], ctx: StepContext, effect: dict[str, Any], *,
               from_status: str, resolved_from_uncertain: bool = False) -> bool:
        agent = self.agents[step["agent"]]
        payload = agent.payload(ctx)
        try:
            ok, detail = agent.verify(ctx, effect)
        except Exception as exc:
            return self._fail(run, step, from_status, f"verification read failed: {type(exc).__name__}: {exc}")
        if not ok:
            self.gateway.record(agent.name, agent.action, payload, "verification_failed", detail, run["id"], step["name"])
            return self._fail(run, step, from_status, f"provider state does not match: {detail}")
        if not self.handoffs.move_step(run["id"], step["name"], from_status, "verified",
                                       {"effect": {**effect, **detail}, "verified_at": now_iso(), "error": None,
                                        "resolved_from_uncertain": resolved_from_uncertain}):
            # Contained (or reaped) while running: the step stays uncertain until verified again.
            return False
        self.gateway.record(agent.name, agent.action, payload, "verified",
                            {**detail, "resolved_from_uncertain": resolved_from_uncertain}, run["id"], step["name"])
        latest = self._run(run["id"])
        if latest["status"] == "uncertain":
            self.handoffs.set_run_status(run["id"], "paused" if latest["paused"] else "running")
        return True

    def _fail(self, run: dict[str, Any], step: dict[str, Any], from_status: str, error: str,
              status: str = "failed") -> bool:
        self.handoffs.move_step(run["id"], step["name"], from_status, "failed", {"error": error[:1000]})
        self.handoffs.set_run_status(run["id"], status, error=f"{step['name']}: {error}"[:1000])
        self._alert(f":warning: Handoff {run['id']} (quote {run['quote_id']}) stopped at '{step['name']}': {error[:300]}. "
                    f"Later steps did not run.")
        return False

    def _schedule(self, run_id: str) -> None:
        run = self.handoffs.get_run(run_id)
        nxt = next((s for s in run["steps"] if s["status"] != "verified"), None)
        job = {"type": "handoff_advance", "run_id": run_id, "agent": nxt["agent"] if nxt else "handoff"}
        if self.enqueue is not None:
            self.enqueue(job)
        else:
            self.advance(run_id)

    def _run(self, run_id: str) -> dict[str, Any]:
        run = self.handoffs.get_run(run_id)
        if run is None:
            raise HandoffError(404, f"handoff run {run_id} not found")
        return run

    def _alert(self, text: str) -> None:
        if self.alert is None:
            return
        try:
            self.alert(text)
        except Exception:  # noqa: BLE001 — an alert failure must not change the run
            log.exception("handoff alert failed")

