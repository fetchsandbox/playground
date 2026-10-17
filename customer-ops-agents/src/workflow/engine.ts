import { randomUUID } from "node:crypto";
import { runBilling } from "../agents/billing";
import { runHandoff } from "../agents/handoff";
import { runIntake } from "../agents/intake";
import { runQuote } from "../agents/quote";
import { runResearch } from "../agents/research";
import { runSurvey } from "../agents/survey";
import type { Deps } from "../deps";
import { FatalError, errorMessage, isRetryable } from "../lib/errors";
import { sleep } from "../lib/retry";
import { type Item, ttlFromNow, when } from "../lib/store";
import type { AgentName, AgentResult, ApprovalDecision, ActionOutcome, Handoff, HandoffState, Intake, IntakeState, CrmContext, WorkflowInput } from "../types";
import { APPROVAL_TTL_MS, approvalBlocks, approvalSummary } from "./approval";
import type { Command } from "./commands";
import { runDispatch } from "./dispatch";
import { type RunEvent, notify, replaceMessage, runKey } from "./notify";

// ---------------------------------------------------------------------------
// The durable run engine — what Step Functions used to do, inside the agent.
//
// A run is one DynamoDB item. Its `phase` advances through:
//
//   RECEIVED → INTAKE_DONE → AGENTS_DONE → AWAITING_APPROVAL ─┬→ APPROVED → DONE
//                                                             ├→ REJECTED
//                                                             └→ EXPIRED
//   (any non-terminal phase) → FAILED | CANCELLED
//
// Every step's output is checkpointed before the phase moves on, so a run
// can be resumed by any container after a crash, a deploy, or an AgentCore
// session ending (15 min idle / 8 h max). Only one container drives a run at
// a time: it holds a lease on the run item, renews it with a heartbeat, and
// every checkpoint is conditional on still owning that lease (fencing), so a
// stalled executor can never overwrite a newer one's progress.
// ---------------------------------------------------------------------------

export type Phase = "RECEIVED" | "INTAKE_DONE" | "AGENTS_DONE" | "AWAITING_APPROVAL" | "APPROVED" | "DONE" | "REJECTED" | "EXPIRED" | "FAILED" | "CANCELLED";

const DRIVABLE: Phase[] = ["RECEIVED", "INTAKE_DONE", "AGENTS_DONE", "AWAITING_APPROVAL", "APPROVED"];
const CANCELLABLE: Phase[] = ["RECEIVED", "INTAKE_DONE", "AGENTS_DONE", "AWAITING_APPROVAL"];
const TERMINAL: Phase[] = ["DONE", "REJECTED", "EXPIRED", "FAILED", "CANCELLED"];

const AGENTS: { name: AgentName; run: (s: IntakeState, d: Deps) => Promise<AgentResult>; needed: (i: Intake) => boolean }[] = [
  { name: "research", run: runResearch, needed: (i) => i.tasks.research },
  { name: "quote", run: runQuote, needed: (i) => i.tasks.quote.needed },
  { name: "billing", run: runBilling, needed: (i) => i.tasks.billing },
  { name: "survey", run: runSurvey, needed: (i) => i.tasks.survey },
];
const agentAttr = (a: AgentName) => `agent_${a}`;

interface RunRecord extends Item {
  runId: string;
  phase: Phase;
  input: WorkflowInput;
  intake?: Intake;
  crm?: CrmContext;
  handoff?: HandoffState["handoff"];
  approvalExpiresAt?: number;
  approvalPosted?: boolean;
  approvalMessageTs?: string | null;
  approval?: ApprovalDecision;
  dispatch?: ActionOutcome[];
  error?: string;
  lastError?: string;
  cancelRequested?: boolean;
  events?: RunEvent[];
  owner?: string;
  leaseExpiresAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface EngineOptions {
  leaseMs?: number;
  heartbeatMs?: number;
  approvalTtlMs?: number;
  /** Attempts per step on transient errors before the run is parked as stalled. */
  stepAttempts?: number;
  stepBackoffMs?: number;
  /** A run with no progress for this long is considered stalled by `sweep`. */
  staleMs?: number;
}

class LeaseLost extends Error {
  override name = "LeaseLost";
}

export class Engine {
  private readonly o: Required<EngineOptions>;
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(
    private readonly d: Deps,
    opts: EngineOptions = {},
  ) {
    this.o = {
      leaseMs: 120_000,
      heartbeatMs: 30_000,
      approvalTtlMs: APPROVAL_TTL_MS,
      stepAttempts: 5,
      stepBackoffMs: 1_000,
      staleMs: 5 * 60_000,
      ...opts,
    };
  }

  /** True while background work is running — drives the /ping HealthyBusy status. */
  get busy() {
    return this.inflight.size > 0;
  }

  /** Resolves when all background work has finished (tests, graceful shutdown). */
  async idle() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  private background(p: Promise<unknown>) {
    const tracked = p.catch((err) => this.d.log.error("background run failed", { err: errorMessage(err) })).finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
  }

  async handle(cmd: Command): Promise<unknown> {
    switch (cmd.action) {
      case "start":
        return this.start(cmd);
      case "decide":
        return this.decide(cmd.runId, cmd.decision, cmd.userId, cmd.wait ?? false);
      case "status":
        return this.status(cmd.runId);
      case "resume":
        return this.kick(cmd.runId, cmd.wait ?? false);
      case "cancel":
        return this.cancel(cmd.runId, cmd.userId);
      case "sweep":
        return this.sweep(cmd.limit ?? 25);
    }
  }

  // --- commands ------------------------------------------------------------

  async start(cmd: Extract<Command, { action: "start" }>) {
    const now = this.d.now();
    const runId = cmd.runId ?? `run-${randomUUID()}`;
    const input: WorkflowInput = {
      runId,
      requestText: cmd.requestText,
      requestedBy: cmd.requestedBy,
      slack: cmd.slack,
      receivedAt: new Date(now).toISOString(),
    };
    const created = await this.d.store.put(
      { pk: runKey(runId), runId, phase: "RECEIVED", input, events: [], open: "1", createdAt: now, updatedAt: now, ttl: ttlFromNow(90 * 86_400, now) } satisfies RunRecord,
      when.notExists(),
    );
    // A duplicate start (retried trigger) is not an error: report the existing run.
    if (!created) return { ...(await this.status(runId)), duplicate: true };
    return this.kick(runId, cmd.wait ?? false);
  }

  async decide(runId: string, decision: ApprovalDecision["decision"], userId: string, wait: boolean) {
    const { approverUserIds } = this.d.config;
    if (approverUserIds.length && !approverUserIds.includes(userId)) return { runId, outcome: "forbidden" as const };
    const now = this.d.now();
    const phase: Phase = decision === "approve" ? "APPROVED" : "REJECTED";

    // The arbiter for double-clicks, two approvers, and clicks racing expiry:
    // exactly one conditional update can move the run out of AWAITING_APPROVAL.
    const won = await this.d.store.update(
      runKey(runId),
      { phase, approval: { decision, decidedBy: userId } satisfies ApprovalDecision, decidedAt: now, updatedAt: now },
      [...when.eq({ phase: "AWAITING_APPROVAL" }), when.gt("approvalExpiresAt", now)],
      phase === "REJECTED" ? ["open"] : [],
    );
    if (!won) {
      const rec = await this.get(runId);
      if (!rec) return { runId, outcome: "not_found" as const };
      if (rec.phase === "AWAITING_APPROVAL" && (rec.approvalExpiresAt ?? 0) <= now) {
        await this.expire(rec);
        return { runId, outcome: "expired" as const };
      }
      if (rec.phase === "EXPIRED") return { runId, outcome: "expired" as const };
      if (rec.approval) return { runId, outcome: "already_decided" as const, phase: rec.phase, decidedBy: rec.approval.decidedBy };
      if (TERMINAL.includes(rec.phase)) return { runId, outcome: "closed" as const, phase: rec.phase };
      return { runId, outcome: "not_ready" as const, phase: rec.phase };
    }

    const rec = (await this.get(runId))!;
    const verdict = phase === "APPROVED" ? `✅ Approved by <@${userId}> — sending now.` : `🛑 Rejected by <@${userId}>.`;
    await replaceMessage(this.d, rec.input, rec.approvalMessageTs, verdict);
    if (phase === "REJECTED") {
      await notify(this.d, rec.input, "rejected", `🛑 Rejected by <@${userId}>. Nothing was sent to the customer. Draft quote and CRM note were kept for reference.`);
      return { runId, outcome: "recorded" as const, phase };
    }
    const view = await this.kick(runId, wait);
    return { ...view, outcome: "recorded" as const };
  }

  async cancel(runId: string, userId: string) {
    const now = this.d.now();
    // Nobody drives a run that's waiting for approval, so cancel it directly.
    if (await this.d.store.update(runKey(runId), { phase: "CANCELLED", updatedAt: now, cancelledBy: userId }, when.eq({ phase: "AWAITING_APPROVAL" }), ["open"])) {
      const rec = (await this.get(runId))!;
      await replaceMessage(this.d, rec.input, rec.approvalMessageTs, `🚫 Cancelled by <@${userId}>.`);
      await notify(this.d, rec.input, "cancelled", `🚫 Cancelled by <@${userId}>. Nothing was sent.`);
      return { runId, outcome: "cancelled" as const };
    }
    // Mid-flight: flag it; the driver stops before the next step.
    if (await this.d.store.update(runKey(runId), { cancelRequested: true, cancelledBy: userId }, when.in("phase", CANCELLABLE))) {
      await this.kick(runId, false);
      return { runId, outcome: "cancelling" as const };
    }
    const rec = await this.get(runId);
    return { runId, outcome: rec ? ("not_cancellable" as const) : ("not_found" as const), phase: rec?.phase };
  }

  async status(runId: string) {
    let rec = await this.get(runId);
    if (!rec) return { runId, phase: "NOT_FOUND" as const };
    if (rec.phase === "AWAITING_APPROVAL" && (rec.approvalExpiresAt ?? Infinity) <= this.d.now()) {
      await this.expire(rec);
      rec = (await this.get(runId))!;
    }
    return view(rec);
  }

  async sweep(limit: number) {
    const now = this.d.now();
    const runs = (await this.d.store.listOpen(limit)) as RunRecord[];
    let expired = 0;
    let resumed = 0;
    for (const r of runs) {
      if (r.phase === "AWAITING_APPROVAL" && r.approvalPosted && (r.approvalExpiresAt ?? Infinity) <= now) {
        if (await this.expire(r)) expired++;
      } else if (DRIVABLE.includes(r.phase) && !(r.phase === "AWAITING_APPROVAL" && r.approvalPosted) && (r.leaseExpiresAt ?? 0) < now && r.updatedAt < now - this.o.staleMs) {
        this.background(this.drive(r.runId));
        resumed++;
      }
    }
    return { scanned: runs.length, expired, resumed };
  }

  // --- driving -------------------------------------------------------------

  /** Drive the run, in the background (default) or inline when `wait`. */
  private async kick(runId: string, wait: boolean) {
    if (wait) await this.drive(runId);
    else this.background(this.drive(runId));
    return this.status(runId);
  }

  private get(runId: string) {
    return this.d.store.get(runKey(runId)) as Promise<RunRecord | undefined>;
  }

  private async expire(rec: RunRecord) {
    const now = this.d.now();
    const ok = await this.d.store.update(runKey(rec.runId), { phase: "EXPIRED", updatedAt: now }, [...when.eq({ phase: "AWAITING_APPROVAL" }), when.lt("approvalExpiresAt", now + 1)], ["open"]);
    if (ok) {
      await replaceMessage(this.d, rec.input, rec.approvalMessageTs, "⌛ This approval expired.");
      await notify(this.d, rec.input, "expired", "⌛ Approval window expired; nothing was sent. Re-run the request to start again.");
    }
    return ok;
  }

  /** Advance the run as far as it can go. Safe to call concurrently from anywhere. */
  async drive(runId: string, depth = 0): Promise<void> {
    const { store, log } = this.d;
    const pk = runKey(runId);
    const me = randomUUID();
    const acquired = await store.update(pk, { owner: me, leaseExpiresAt: this.d.now() + this.o.leaseMs }, [when.missingOrLt("leaseExpiresAt", this.d.now()), when.in("phase", DRIVABLE)]);
    if (!acquired) return; // someone else is driving, or there's nothing to do

    let lost = false;
    const heartbeat = setInterval(() => {
      store
        .update(pk, { leaseExpiresAt: this.d.now() + this.o.leaseMs }, when.eq({ owner: me }))
        .then((ok) => (lost ||= !ok))
        .catch(() => {});
    }, this.o.heartbeatMs);

    // Every checkpoint is fenced on our lease.
    const save = async (set: Record<string, unknown>, remove: string[] = []) => {
      if (lost || !(await store.update(pk, { ...set, updatedAt: this.d.now() }, when.eq({ owner: me }), remove))) {
        lost = true;
        throw new LeaseLost(`lost lease on ${runId}`);
      }
    };
    const rlog = log.child({ runId });

    try {
      for (;;) {
        const rec = (await this.get(runId))!;
        if (rec.cancelRequested && CANCELLABLE.includes(rec.phase)) {
          await save({ phase: "CANCELLED" }, ["open"]);
          await notify(this.d, rec.input, "cancelled", "🚫 Cancelled. Nothing was sent.");
          return;
        }
        rlog.info("driving", { phase: rec.phase });
        switch (rec.phase) {
          case "RECEIVED": {
            const s = await this.step(() => runIntake(rec.input, this.d));
            await save({ phase: "INTAKE_DONE", intake: s.intake, crm: s.crm });
            break;
          }
          case "INTAKE_DONE": {
            const base = { ...rec.input, intake: rec.intake!, crm: rec.crm! };
            // Fan out. Each agent's result is checkpointed on its own, so a
            // resumed run only re-runs the agents that hadn't finished.
            await Promise.all(
              AGENTS.map(async ({ name, run, needed }) => {
                if (rec[agentAttr(name)]) return;
                let result: AgentResult;
                if (!needed(base.intake)) result = { agent: name, status: "skipped" };
                else {
                  try {
                    result = await this.step(() => run(base, this.d));
                  } catch (err) {
                    if (err instanceof LeaseLost) throw err;
                    // Isolate the failure: the other agents and the handoff carry on.
                    result = { agent: name, status: "failed", error: (err as Error).name ?? "Error", cause: errorMessage(err) };
                  }
                }
                await save({ [agentAttr(name)]: result });
              }),
            );
            await save({ phase: "AGENTS_DONE" });
            break;
          }
          case "AGENTS_DONE": {
            const s = await this.step(() => runHandoff({ ...rec.input, intake: rec.intake!, crm: rec.crm!, agents: agentsOf(rec) }, this.d));
            // Enter AWAITING_APPROVAL *before* showing the buttons, so a fast click always finds the run ready.
            await save({ phase: "AWAITING_APPROVAL", handoff: s.handoff, approvalExpiresAt: this.d.now() + this.o.approvalTtlMs, approvalPosted: false });
            break;
          }
          case "AWAITING_APPROVAL": {
            if (!rec.approvalPosted) {
              const s = handoffState(rec);
              const msg = await this.step(() => notify(this.d, rec.input, "approval", approvalSummary(s), approvalBlocks(s)));
              // Not fenced on phase: a decision may already have landed, and that's fine.
              await save({ approvalPosted: true, approvalMessageTs: msg.ts });
              continue;
            }
            return; // parked until `decide`
          }
          case "APPROVED": {
            const s = handoffState(rec);
            const done = await this.step(() => runDispatch({ ...s, approval: rec.approval! }, this.d));
            await save({ phase: "DONE", dispatch: done.dispatch }, ["open"]);
            const icon = { done: "✅", skipped: "⏭️", failed: "❌" } as const;
            await notify(this.d, rec.input, "done", `*Done.*\n${done.dispatch.map((o) => `${icon[o.status]} ${o.action}: ${o.detail}`).join("\n")}`);
            return;
          }
          default:
            return; // terminal
        }
      }
    } catch (err) {
      if (err instanceof LeaseLost) {
        rlog.warn("lease lost; another executor took over");
        return;
      }
      const rec = await this.get(runId);
      if (isRetryable(err)) {
        // Still transient after all attempts: park it. `sweep` or `resume` picks it up later.
        rlog.warn("run stalled", { err: errorMessage(err) });
        await save({ lastError: errorMessage(err) }).catch(() => {});
        return;
      }
      rlog.error("run failed", { err: errorMessage(err) });
      await save({ phase: "FAILED", error: errorMessage(err) }, ["open"]).catch(() => {});
      if (rec) await notify(this.d, rec.input, "failed", `⚠️ Workflow stopped: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    } finally {
      clearInterval(heartbeat);
      await store.update(pk, { leaseExpiresAt: 0 }, when.eq({ owner: me }), ["owner"]).catch(() => {});
      // A decision may have landed while we held the lease (its own drive() found
      // the lease taken). Don't leave it waiting for the next sweep.
      const after = await this.get(runId).catch(() => undefined);
      if (!lost && depth < 3 && after?.phase === "APPROVED" && !after.owner) await this.drive(runId, depth + 1);
    }
  }

  /** Step-level retry for transient errors, with full-jitter backoff. */
  private async step<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (!isRetryable(err) || attempt >= this.o.stepAttempts) throw err;
        const hinted = (err as { retryAfterMs?: number }).retryAfterMs;
        await sleep(hinted ?? Math.random() * this.o.stepBackoffMs * 2 ** (attempt - 1));
      }
    }
  }
}

function agentsOf(rec: RunRecord): AgentResult[] {
  return AGENTS.map(({ name }) => (rec[agentAttr(name)] as AgentResult | undefined) ?? { agent: name, status: "skipped" });
}

function handoffState(rec: RunRecord): HandoffState {
  if (!rec.intake || !rec.crm || !rec.handoff) throw new FatalError(`run ${rec.runId} is missing checkpointed state`);
  return { ...rec.input, intake: rec.intake, crm: rec.crm, agents: agentsOf(rec), handoff: rec.handoff };
}

/** What `status` returns: everything LoopLabs needs to render the run. */
function view(rec: RunRecord) {
  const handoff: Partial<Handoff> | undefined = rec.handoff;
  return {
    runId: rec.runId,
    phase: rec.phase,
    terminal: TERMINAL.includes(rec.phase),
    summary: rec.intake?.summary,
    customer: rec.intake?.customer,
    agents: agentsOf(rec)
      .filter((a) => rec[agentAttr(a.agent)])
      .map((a) => ({ agent: a.agent, status: a.status, ...(a.status === "failed" ? { error: a.cause ?? a.error } : {}) })),
    handoff: handoff && { summary: handoff.summary, nextSteps: handoff.nextSteps, riskLevel: handoff.riskLevel, actions: rec.handoff?.actions },
    approval:
      rec.phase === "AWAITING_APPROVAL" || rec.approval
        ? { expiresAt: rec.approvalExpiresAt ? new Date(rec.approvalExpiresAt).toISOString() : undefined, ...rec.approval, prompt: rec.handoff && rec.intake ? approvalSummary(handoffState(rec)) : undefined }
        : undefined,
    dispatch: rec.dispatch,
    error: rec.error,
    lastError: rec.lastError,
    events: rec.events ?? [],
    updatedAt: new Date(rec.updatedAt).toISOString(),
  };
}
