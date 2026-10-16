// Step Functions task handlers. One bundle, one Lambda per export (see
// infra/stack.ts). Each is a thin shell: load deps, call the pure step.
// Errors propagate by name (RetryableError / FatalError / …) so the state
// machine's Retry and Catch rules can act on them.
import { runBilling } from "../agents/billing";
import { runHandoff } from "../agents/handoff";
import { runIntake } from "../agents/intake";
import { runQuote } from "../agents/quote";
import { runResearch } from "../agents/research";
import { runSurvey } from "../agents/survey";
import { type Deps, getDeps } from "../deps";
import { errorMessage } from "../lib/errors";
import { requestApproval as requestApprovalStep } from "../workflow/approval";
import { runDispatch } from "../workflow/dispatch";
import { type NotifyEvent, runNotify } from "../workflow/notify";
import type { ApprovedState, FanOutState, HandoffState, IntakeState, WorkflowInput } from "../types";

function step<E extends { runId?: string; state?: { runId: string } }, R>(name: string, fn: (e: E, d: Deps) => Promise<R>) {
  return async (event: E): Promise<R> => {
    const base = await getDeps();
    const runId = event.runId ?? event.state?.runId;
    const d = { ...base, log: base.log.child({ step: name, runId }) };
    const started = Date.now();
    try {
      const out = await fn(event, d);
      d.log.info("step ok", { ms: Date.now() - started });
      return out;
    } catch (err) {
      d.log.warn("step failed", { ms: Date.now() - started, err: errorMessage(err) });
      throw err;
    }
  };
}

export const intake = step("intake", (e: WorkflowInput, d) => runIntake(e, d));
export const research = step("research", (e: IntakeState, d) => runResearch(e, d));
export const quote = step("quote", (e: IntakeState, d) => runQuote(e, d));
export const billing = step("billing", (e: IntakeState, d) => runBilling(e, d));
export const survey = step("survey", (e: IntakeState, d) => runSurvey(e, d));
export const handoff = step("handoff", (e: FanOutState, d) => runHandoff(e, d));
export const requestApproval = step("requestApproval", (e: { taskToken: string; state: HandoffState }, d) =>
  requestApprovalStep(e.state, e.taskToken, d),
);
export const dispatch = step("dispatch", (e: ApprovedState, d) => runDispatch(e, d));
export const notify = step("notify", (e: NotifyEvent, d) => runNotify(e, d));
