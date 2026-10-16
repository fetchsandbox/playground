// In-process mirror of the state machine in infra/stack.ts — same steps, same
// Retry/Catch semantics — for tests and `npm run local`. If you change the
// state machine, change this too.
import { runBilling } from "../agents/billing";
import { runHandoff } from "../agents/handoff";
import { runIntake } from "../agents/intake";
import { runQuote } from "../agents/quote";
import { runResearch } from "../agents/research";
import { runSurvey } from "../agents/survey";
import type { Deps } from "../deps";
import { errorMessage, isRetryable } from "../lib/errors";
import { sleep } from "../lib/retry";
import { type TaskCallbacks, requestApproval } from "../workflow/approval";
import { runDispatch } from "../workflow/dispatch";
import { runNotify } from "../workflow/notify";
import type { AgentName, AgentResult, ApprovalDecision, DispatchState, IntakeState, WorkflowInput } from "../types";

const MAX_ATTEMPTS = 5;

/** Step Functions `Retry` on the transient error names, with a tiny backoff. */
async function withStepRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || attempt >= MAX_ATTEMPTS) throw err;
      await sleep(5 * attempt);
    }
  }
}

/** Stand-in for `.waitForTaskToken` + SendTaskSuccess. */
export class LocalTaskBroker implements TaskCallbacks {
  private waiters = new Map<string, (d: ApprovalDecision) => void>();
  successCalls = 0;
  wait(token: string, timeoutMs: number): Promise<ApprovalDecision | "timeout"> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(token);
        resolve("timeout");
      }, timeoutMs);
      this.waiters.set(token, (d) => {
        clearTimeout(timer);
        resolve(d);
      });
    });
  }
  async success(token: string, output: ApprovalDecision) {
    const w = this.waiters.get(token);
    if (!w) throw Object.assign(new Error("task token is no longer valid"), { name: "TaskTimedOut" });
    this.waiters.delete(token);
    this.successCalls++;
    w(output);
  }
}

export type Terminal = "done" | "rejected" | "expired" | "failed";

export interface LocalRunOptions {
  broker: LocalTaskBroker;
  /** Called once the approval message is posted — simulate the human here. */
  onApprovalRequested: (runId: string) => void | Promise<void>;
  approvalTimeoutMs?: number;
}

const AGENTS: { name: AgentName; run: (s: IntakeState, d: Deps) => Promise<AgentResult>; needed: (s: IntakeState) => boolean }[] = [
  { name: "research", run: runResearch, needed: (s) => s.intake.tasks.research },
  { name: "quote", run: runQuote, needed: (s) => s.intake.tasks.quote.needed },
  { name: "billing", run: runBilling, needed: (s) => s.intake.tasks.billing },
  { name: "survey", run: runSurvey, needed: (s) => s.intake.tasks.survey },
];

export async function runWorkflowLocally(input: WorkflowInput, d: Deps, opts: LocalRunOptions): Promise<{ terminal: Terminal; state: unknown }> {
  const fail = async (state: WorkflowInput, err: unknown) => {
    const error = { Error: (err as Error).name ?? "Error", Cause: JSON.stringify({ errorMessage: errorMessage(err) }) };
    await withStepRetry(() => runNotify({ kind: "failed", state: { ...state, error } }, d));
    return { terminal: "failed" as const, state: { ...state, error } };
  };

  let intake: IntakeState;
  try {
    intake = await withStepRetry(() => runIntake(input, d));
  } catch (err) {
    return fail(input, err);
  }

  // Parallel state: branches run concurrently; each catches its own failure.
  const agents = await Promise.all(
    AGENTS.map(async ({ name, run, needed }): Promise<AgentResult> => {
      if (!needed(intake)) return { agent: name, status: "skipped" };
      try {
        return await withStepRetry(() => run(intake, d));
      } catch (err) {
        return { agent: name, status: "failed", error: (err as Error).name, cause: errorMessage(err) };
      }
    }),
  );

  let handoff;
  try {
    handoff = await withStepRetry(() => runHandoff({ ...intake, agents }, d));
  } catch (err) {
    return fail(intake, err);
  }

  const token = `local-token-${input.runId}`;
  const decisionP = opts.broker.wait(token, opts.approvalTimeoutMs ?? 5_000);
  try {
    await withStepRetry(() => requestApproval(handoff, token, d));
  } catch (err) {
    return fail(handoff, err);
  }
  await opts.onApprovalRequested(input.runId);
  const decision = await decisionP;

  if (decision === "timeout") {
    await withStepRetry(() => runNotify({ kind: "expired", state: handoff }, d));
    return { terminal: "expired", state: handoff };
  }
  const approved = { ...handoff, approval: decision };
  if (decision.decision !== "approve") {
    await withStepRetry(() => runNotify({ kind: "rejected", state: approved }, d));
    return { terminal: "rejected", state: approved };
  }

  let done: DispatchState;
  try {
    done = await withStepRetry(() => runDispatch(approved, d));
  } catch (err) {
    return fail(approved, err);
  }
  await withStepRetry(() => runNotify({ kind: "done", state: done }, d));
  return { terminal: "done", state: done };
}
