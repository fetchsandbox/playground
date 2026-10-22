import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { checkpoint, validateReviewed, sameScope, type ControlConfig } from "./looplabs-control";
import type { ProviderFactory } from "../providers";
import type { Drafter } from "./drafter";
import { errorCode, errorMessage, SkipAction } from "./errors";
import type { Logger } from "./log";
import type { Item, KvStore } from "./store";
import {
  type ActionContext,
  type ActionReceipt,
  type ActionRecord,
  type ActionStatus,
  type AgentRecord,
  type Checkpoints,
  type AgentResults,
  CLOSED,
  type PlannedAction,
  type RunContext,
  type RunRecord,
  type WorkflowDef,
} from "./types";

// ---------------------------------------------------------------------------
// Command API (POST /invocations)
// ---------------------------------------------------------------------------

const User = z.object({ userId: z.string().min(1), userName: z.string().optional() });

export const CommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("describe") }),
  z.object({
    action: z.literal("start"),
    /** Idempotency key (trigger/event id). Repeating it returns the existing run. */
    runId: z.string().min(1).max(200).regex(/^[\w.:@-]+$/).optional(),
    input: z.unknown(),
    requestedBy: User,
    /** Free-form labels the control plane wants echoed back (team, trigger, test case...). */
    labels: z.record(z.string(), z.string().max(200)).optional(),
    /** Block until the run parks or finishes (default true). */
    wait: z.boolean().optional(),
  }),
  z.object({ action: z.literal("status"), runId: z.string().min(1) }),
  z.object({
    action: z.literal("decide"),
    runId: z.string().min(1),
    decision: z.enum(["approve", "reject"]),
    userId: z.string().min(1),
    wait: z.boolean().optional(),
  }),
  z.object({ action: z.literal("cancel"), runId: z.string().min(1), userId: z.string().min(1) }),
  z.object({ action: z.literal("resume"), runId: z.string().min(1), wait: z.boolean().optional() }),
  z.object({ action: z.literal("reconcile"), runId: z.string().min(1) }),
  // Kit v2
  z.object({
    action: z.literal("signal"),
    runId: z.string().min(1),
    /** The action the signal is for (a per-item decision, a callback, a confirmation). */
    actionId: z.string().min(1),
    value: z.enum(["approve", "reject"]),
    userId: z.string().min(1),
    note: z.string().max(500).optional(),
    wait: z.boolean().optional(),
  }),
  /** Wakes every waiting run whose timer or signal deadline is due (EventBridge Scheduler or the server's interval). */
  z.object({ action: z.literal("tick"), wait: z.boolean().optional() }),
  /** The run's hash-chained audit trail, verified. */
  z.object({ action: z.literal("evidence"), runId: z.string().min(1) }),
]);
export type Command = z.infer<typeof CommandSchema>;

/** Engine answer: HTTP status for the server plus a JSON body. */
export interface Reply {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON reply, consumed over HTTP
  body: Record<string, any>;
}

export interface EngineDeps {
  control?: ControlConfig;
  controlSink?: (event:Record<string,unknown>)=>void;
  store: KvStore;
  providers: ProviderFactory;
  drafter: Drafter;
  log: Logger;
  /** Default approvers when the input doesn't name any (empty = any caller the control plane forwards). */
  approvers?: string[];
  approvalTtlMs?: number;
  agentTimeoutMs?: number;
  /** A RUNNING/APPROVED run untouched this long may be resumed by anyone. */
  staleMs?: number;
  now?: () => number;
}

const MAX_EVENTS = 100;

class Timeout extends Error {
  override name = "TimeoutError";
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, rej) => (timer = setTimeout(() => rej(new Timeout(`${what} exceeded ${ms}ms`)), ms)))]).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * Drives runs of ONE workflow (one AgentCore runtime = one workflow):
 *
 *   start → RUNNING ─ agents in parallel ─ compose ─ plan ─ auto actions ─┬→ DONE
 *                                                                        └→ AWAITING_APPROVAL ─ decide ─┬→ APPROVED → gated actions → DONE
 *                                                                                                       └→ REJECTED
 *
 * Every transition is a compare-and-swap on the run item, every side effect
 * is claimed in the store before it runs (so a retry or a second container
 * can't repeat it), and plans are pure, so approve/resume/reconcile rebuild
 * the exact same actions from the stored agent outputs.
 */
export class Engine<I> {
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly driving = new Set<string>();
  private readonly emittedControl=new Set<string>();
  private readonly now: () => number;

  constructor(
    readonly workflow: WorkflowDef<I>,
    private readonly deps: EngineDeps,
  ) {
    this.now = deps.now ?? Date.now;
  }

  /** True while a run is executing in the background (AgentCore /ping → HealthyBusy). */
  get busy() {
    return this.inflight.size > 0;
  }

  /** Provider clients for a webhook mapper, stamped with the delivery's correlation headers. */
  providersFor(correlation: Record<string, string>) {
    return this.deps.providers(correlation);
  }

  async idle() {
    await Promise.allSettled([...this.inflight]);
  }

  async handle(cmd: Command, correlation: Record<string, string> = {}): Promise<Reply> {
    switch (cmd.action) {
      case "describe":
        return { status: 200, body: this.describe() };
      case "start":
        return this.start(cmd, correlation);
      case "status": {
        const run = await this.load(cmd.runId);
        return run ? { status: 200, body: this.view(await this.expireIfDue(run)) } : notFound(cmd.runId);
      }
      case "decide":
        return this.decide(cmd);
      case "cancel":
        return this.cancel(cmd);
      case "resume":
        return this.resume(cmd);
      case "reconcile":
        return this.reconcile(cmd.runId);
      case "signal":
        return this.signal(cmd);
      case "tick":
        return this.tick(cmd.wait !== false);
      case "evidence":
        return this.evidence(cmd.runId);
    }
  }

  describe() {
    const wf = this.workflow;
    return {
      workflow: wf.id,
      metadata: deploymentMetadata(),
      title: wf.title,
      org: wf.org,
      team: wf.team,
      description: wf.description,
      agents: wf.agents.map((a) => ({ name: a.name, needs: a.needs })).concat(wf.compose ? [{ name: wf.compose.name, needs: [] }] : []),
      actions: wf.catalog,
      input: z.toJSONSchema(wf.input as z.ZodType, { unrepresentable: "any" }),
      commands: ["describe", "start", "status", "decide", "cancel", "resume", "reconcile", "signal", "tick", "evidence"],
    };
  }

  // -------------------------------------------------------------------------
  // start
  // -------------------------------------------------------------------------

  private async start(cmd: Extract<Command, { action: "start" }>, correlation: Record<string, string>): Promise<Reply> {
    const parsed = this.workflow.input.safeParse(cmd.input);
    if (!parsed.success) {
      return { status: 400, body: { error: "invalid input", issues: parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`) } };
    }
    const runId = cmd.runId ?? `run_${randomUUID()}`;
    const at = new Date(this.now()).toISOString();
    const run: RunRecord = {
      pk: pk(runId),
      runId,
      workflow: this.workflow.id,
      org: this.workflow.org,
      team: this.workflow.team,
      phase: "RUNNING",
      input: parsed.data,
      requestedBy: cmd.requestedBy,
      labels: cmd.labels ?? {},
      correlation,
      agents: [],
      actions: [],
      duplicateStarts: 0,
      events: [{ at, msg: `started by ${cmd.requestedBy.userId}` }],
      ...(this.deps.control ? {control:{scope:this.deps.control.scope,events:[]}} : {}),
      createdAt: at,
      updatedAt: at,
    };
    if(this.deps.control)checkpoint(undefined,run,this.deps.control,at);
    if (!(await this.deps.store.create(run as unknown as Item))) {
      const existing = await this.mutate(runId, (r) => {
        r.duplicateStarts++;
        this.event(r, "duplicate start ignored");
      });
      return { status: 200, body: { ...this.view(existing!), duplicate: true } };
    }
    this.emitControl(run);
    const job = this.drive(runId);
    if (cmd.wait !== false) await job;
    return { status: 200, body: { ...this.view((await this.load(runId))!), duplicate: false } };
  }

  // -------------------------------------------------------------------------
  // The driver: idempotent, resumable from any checkpoint
  // -------------------------------------------------------------------------

  private drive(runId: string): Promise<void> {
    if (this.driving.has(runId)) return Promise.resolve();
    this.driving.add(runId);
    const job = this.driveInner(runId)
      .catch(async (err) => {
        // Unexpected engine error: keep the run resumable rather than losing it.
        this.deps.log.error("drive failed", { runId, err: errorMessage(err) });
        await this.mutate(runId, (r) => {
          r.lastError = errorMessage(err);
          this.event(r, `paused: ${errorMessage(err)}`);
        }).catch(() => {});
      })
      .finally(() => {
        this.driving.delete(runId);
        this.inflight.delete(job);
      });
    this.inflight.add(job);
    return job;
  }

  private async driveInner(runId: string): Promise<void> {
    let run = (await this.load(runId))!;
    const ctx = this.context(run);

    if (run.phase === "RUNNING") {
      // Stage 1: agents in parallel. Finished agents survive a resume.
      const done = new Map(run.agents.filter((a) => a.status !== "failed").map((a) => [a.name, a]));
      const todo = this.workflow.agents.filter((a) => !done.has(a.name));
      const fresh = await Promise.all(todo.map((a) => this.runAgent(a.name, a.needs, () => a.run(ctx), ctx)));
      run = (await this.mutate(runId, (r) => {
        r.agents = [...this.workflow.agents.map((a) => done.get(a.name) ?? fresh.find((f) => f.name === a.name)!)];
        this.event(r, `agents: ${r.agents.map((a) => `${a.name}=${a.status}`).join(", ")}`);
      }))!;

      // Stage 2: compose (sees every agent result, including failures).
      const compose = this.workflow.compose;
      if (compose && !run.agents.some((a) => a.name === compose.name && a.status === "ok")) {
        const results = this.results(run);
        const rec = await this.runAgent(compose.name, [], () => compose.run(ctx, results), ctx);
        run = (await this.mutate(runId, (r) => {
          r.agents = r.agents.filter((a) => a.name !== compose.name).concat(rec);
        }))!;
      }

      // Plan, keeping the status of anything already applied by an earlier attempt.
      const results = this.results(run);
      const planned = this.workflow.plan(ctx, results);
      run = (await this.mutate(runId, (r) => {
        const prior = new Map(r.actions.map((a) => [a.id, a]));
        r.actions = planned.map((p) => prior.get(p.id) ?? toRecord(p));
        r.output = this.workflow.output(ctx, results);
        this.event(r, `planned ${planned.length} action(s): ${planned.filter((p) => p.gate === "approval").length} need approval`);
      }))!;

      if ((await this.execute(runId, ctx, planned, "auto")) === "compensated") return;
      run = (await this.load(runId))!;
      if (run.phase !== "RUNNING") return; // cancelled meanwhile

      const needsApproval = run.actions.some((a) => a.status === "pending_approval");
      run = (await this.mutate(runId, (r) => {
        if (r.phase !== "RUNNING") return;
        if (needsApproval) {
          const fromInput = (r.input as { approvers?: string[] })?.approvers;
          r.approval = {
            approvers: fromInput?.length ? fromInput : (this.deps.approvers ?? []),
            expiresAt: new Date(this.now() + (this.deps.approvalTtlMs ?? 24 * 3_600_000)).toISOString(),
          };
          r.phase = "AWAITING_APPROVAL";
          setWake(r);
          this.event(r, "awaiting approval");
        } else this.settle(r);
      }))!;
      return;
    }

    if (run.phase === "APPROVED") {
      const plan = this.workflow.plan(ctx, this.results(run));
      if ((await this.execute(runId, ctx, plan, "approval")) === "compensated") return;
      // Timers or signals that came due while the run waited for its approval.
      if (run.actions.some(isWaiting) && (await this.execute(runId, ctx, plan, "auto")) === "compensated") return;
      await this.mutate(runId, (r) => {
        if (r.phase !== "APPROVED") return;
        this.settle(r);
      });
      return;
    }

    // Kit v2: a waiting run executes whatever timer or signal is due, then waits again or finishes.
    if (run.phase === "WAITING" || (run.phase === "AWAITING_APPROVAL" && run.actions.some(isWaiting))) {
      const plan = this.workflow.plan(ctx, this.results(run));
      if ((await this.execute(runId, ctx, plan, "auto")) === "compensated") return;
      if (run.approval?.decision === "approve" && (await this.execute(runId, ctx, plan, "approval")) === "compensated") return;
      await this.mutate(runId, (r) => {
        if (r.phase === "WAITING") this.settle(r);
        else if (r.phase === "AWAITING_APPROVAL") setWake(r);
      });
      if (!run.actions.some((a) => a.status === "failed")) return;
      run = (await this.load(runId))!;
    }

    // Repair: a parked or finished run retries effects that failed (provider
    // outage, missing scope fixed since...). Only gates that were allowed to run.
    if ((run.phase === "AWAITING_APPROVAL" || run.phase === "DONE") && run.actions.some((a) => a.status === "failed")) {
      const plan = this.workflow.plan(ctx, this.results(run));
      await this.execute(runId, ctx, plan, "auto");
      if (run.phase === "DONE" && run.approval?.decision === "approve") await this.execute(runId, ctx, plan, "approval");
    }
  }

  private async runAgent(name: string, needs: string[], fn: () => Promise<{ summary: string; data: unknown }>, ctx: RunContext<I>): Promise<AgentRecord> {
    const started = this.now();
    const missing = needs.filter((p) => !ctx.providers[p as keyof typeof ctx.providers]);
    if (missing.length) {
      return { name, status: "skipped", error: `not configured: ${missing.join(", ")}`, errorCode: "not_configured", durationMs: 0 };
    }
    try {
      const out = await withTimeout(fn(), this.deps.agentTimeoutMs ?? 90_000, `agent ${name}`);
      return { name, status: "ok", summary: out.summary, output: out.data, durationMs: this.now() - started };
    } catch (err) {
      ctx.log.warn("agent failed", { agent: name, err: errorMessage(err) });
      return { name, status: "failed", error: errorMessage(err), errorCode: errorCode(err), durationMs: this.now() - started };
    }
  }

  /** Applies every not-yet-applied action of `gate`, in plan order (later actions may use earlier receipts). */
  private async execute(runId: string, ctx: RunContext<I>, planned: PlannedAction<I>[], gate: "auto" | "approval"): Promise<"done" | "compensated"> {
    for (const p of planned.filter((x) => x.gate === gate)) {
      const run = (await this.load(runId))!;
      if (run.cancelRequested || run.phase === "CANCELLED") {
        await this.mutate(runId, (r) => {
          for (const a of r.actions) if (a.status === "planned" || a.status === "pending_approval" || isWaiting(a)) a.status = "skipped";
          r.phase = "CANCELLED";
          this.event(r, "cancelled");
        });
        return "done";
      }
      const rec = run.actions.find((a) => a.id === p.id);
      if (!rec || rec.status === "applied" || rec.status === "skipped" || rec.status === "rejected" || rec.status === "compensated") continue;

      // Kit v2: a timer that isn't due, or a signal that hasn't come, leaves the action waiting.
      const gateState = this.readiness(p, rec, run.actions);
      if (gateState !== "ready") {
        const why = gateState.error ? (gateState.status === "skipped" ? { detail: { reason: gateState.error } } : { error: gateState.error, errorCode: "signal_deadline" }) : {};
        if (gateState.status !== rec.status || gateState.signal) await this.updateAction(runId, p.id, { status: gateState.status, ...(gateState.signal ? { signal: gateState.signal } : {}), ...why });
        if (gateState.status === "failed" && p.onFailure === "compensate") return this.compensateRun(runId, ctx, planned, p.id);
        // A deadline that defaults to approve runs the action now; anything else keeps waiting.
        if (gateState.signal?.value !== "approve") continue;
      }

      if (!ctx.providers[p.provider]) {
        await this.updateAction(runId, p.id, { status: "skipped", error: `${p.provider} not configured`, errorCode: "not_configured" });
        continue;
      }

      // Claim the side effect. A claim already held means another attempt
      // applied it (copy its receipt) or is applying it right now (leave it).
      const claimKey = `effect#${runId}#${p.id}`;
      if (!(await this.deps.store.create({ pk: claimKey, state: "running", at: new Date(this.now()).toISOString() }))) {
        const claim = await this.deps.store.get(claimKey);
        if (claim?.state === "applied") {
          await this.updateAction(runId, p.id, { status: "applied", ref: claim.ref as string, detail: claim.detail as Record<string, unknown> });
        }
        continue;
      }

      const fresh = (await this.load(runId))!;
      const applied = Object.fromEntries(
        fresh.actions.filter((a) => a.status === "applied" && a.ref).map((a) => [a.id, { ref: a.ref!, detail: a.detail } satisfies ActionReceipt]),
      );
      const statuses = Object.fromEntries(fresh.actions.map((a) => [a.id, a.status]));
      try {
        const receipt = await p.execute({ ...ctx, applied, statuses, signal: fresh.actions.find((a) => a.id === p.id)?.signal } as ActionContext<I>);
        await this.deps.store.replace({ ...(await this.deps.store.get(claimKey))!, state: "applied", ref: receipt.ref, detail: receipt.detail ?? {} });
        await this.updateAction(runId, p.id, { status: "applied", ref: receipt.ref, detail: receipt.detail, appliedAt: new Date(this.now()).toISOString() });
      } catch (err) {
        if (err instanceof SkipAction) {
          // Decided not to apply: final, not retried.
          await this.deps.store.replace({ ...(await this.deps.store.get(claimKey))!, state: "skipped" });
          await this.updateAction(runId, p.id, { status: "skipped", detail: { reason: err.message } });
          continue;
        }
        // Release the claim so a later resume can retry this one effect.
        await this.deps.store.delete(claimKey);
        ctx.log.warn("action failed", { action: p.id, err: errorMessage(err) });
        await this.updateAction(runId, p.id, { status: "failed", error: errorMessage(err), errorCode: errorCode(err) });
        if (p.onFailure === "compensate") return this.compensateRun(runId, ctx, planned, p.id);
      }
    }
    return "done";
  }

  /**
   * Kit v2 gate for timers and signals. "ready" runs the action; otherwise the
   * status it should show. A deadline without a signal applies the action's default.
   */
  private readiness(p: PlannedAction<I>, rec: ActionRecord, all: ActionRecord[] = []): "ready" | { status: ActionStatus; signal?: ActionRecord["signal"]; error?: string } {
    const now = this.now();
    if (p.waitUntil && Date.parse(p.waitUntil) > now) return { status: "scheduled" };
    if (p.after?.some((id) => { const dep = all.find((a) => a.id === id); return dep && !SETTLED.has(dep.status); })) return { status: "scheduled" };
    for (const id of p.requires ?? []) {
      const dep = all.find((a) => a.id === id);
      if (!dep) continue;
      if (!SETTLED.has(dep.status)) return { status: "scheduled" };
      if (dep.status !== "applied") return { status: "skipped", error: `${id} was ${dep.status}` };
    }
    if (!p.awaitSignal) return "ready";
    const sig = rec.signal;
    if (sig) return sig.value === "approve" ? "ready" : { status: "rejected" };
    const deadline = p.awaitSignal.deadline ? Date.parse(p.awaitSignal.deadline) : undefined;
    if (deadline === undefined || deadline > now) return { status: "awaiting_signal" };
    const at = new Date(now).toISOString();
    switch (p.awaitSignal.onDeadline ?? "reject") {
      case "approve":
        // Recorded as a defaulted signal, then executed on the next pass.
        return { status: "awaiting_signal", signal: { value: "approve", by: "deadline", at, defaulted: true } };
      case "fail":
        return { status: "failed", error: `no signal by ${p.awaitSignal.deadline}` };
      default:
        return { status: "rejected", signal: { value: "reject", by: "deadline", at, defaulted: true } };
    }
  }

  /** Kit v2 saga: undo applied effects in reverse plan order, skip everything not yet done, finish the run. */
  private async compensateRun(runId: string, ctx: RunContext<I>, planned: PlannedAction<I>[], failedId: string): Promise<"compensated"> {
    const run = (await this.load(runId))!;
    const statuses = Object.fromEntries(run.actions.map((a) => [a.id, a.status]));
    const applied = Object.fromEntries(run.actions.filter((a) => a.status === "applied" && a.ref).map((a) => [a.id, { ref: a.ref!, detail: a.detail } satisfies ActionReceipt]));
    for (const p of [...planned].reverse()) {
      const rec = run.actions.find((a) => a.id === p.id);
      if (!rec || rec.status !== "applied") continue;
      const at = new Date(this.now()).toISOString();
      if (!p.compensate) {
        await this.mutate(runId, (r) => {
          const a = r.actions.find((x) => x.id === p.id)!;
          a.compensation = { status: "not_supported", at };
          this.event(r, `${p.id}: kept (no undo)`);
        });
        continue;
      }
      try {
        const res = await p.compensate({ ...ctx, applied, statuses } as ActionContext<I>, { ref: rec.ref!, detail: rec.detail });
        await this.mutate(runId, (r) => {
          const a = r.actions.find((x) => x.id === p.id)!;
          a.status = "compensated";
          a.compensation = { status: "applied", ref: res?.ref, at };
          this.event(r, `${p.id}: compensated`);
        });
      } catch (err) {
        await this.mutate(runId, (r) => {
          const a = r.actions.find((x) => x.id === p.id)!;
          a.compensation = { status: "failed", error: errorMessage(err), at };
          this.event(r, `${p.id}: compensation failed (${errorCode(err)})`);
        });
      }
    }
    await this.mutate(runId, (r) => {
      for (const a of r.actions) if (a.status === "planned" || a.status === "pending_approval" || isWaiting(a)) a.status = "skipped";
      if (!CLOSED.includes(r.phase)) r.phase = "DONE";
      delete r.wakeAt;
      this.event(r, `compensated after ${failedId} failed`);
    });
    return "compensated";
  }

  private updateAction(runId: string, id: string, patch: Partial<ActionRecord>) {
    return this.mutate(runId, (r) => {
      const a = r.actions.find((x) => x.id === id);
      if (!a) return;
      if (patch.status === "applied") {
        delete a.error;
        delete a.errorCode;
      }
      Object.assign(a, patch, { attempts: a.attempts + (patch.status === "applied" || patch.status === "failed" ? 1 : 0) });
      this.event(r, `${id}: ${a.status}${a.errorCode ? ` (${a.errorCode})` : ""}`);
    });
  }

  // -------------------------------------------------------------------------
  // decide / cancel / resume / reconcile
  // -------------------------------------------------------------------------

  private async decide(cmd: Extract<Command, { action: "decide" }>, expected?:{revision:string;policyVersion:string}): Promise<Reply> {
    let run = await this.load(cmd.runId);
    if (!run) return notFound(cmd.runId);
    run = await this.expireIfDue(run);
    let outcome: string | undefined;
    const updated = await this.mutate(cmd.runId, (r) => {
      if ((expected || r.control) && (!this.deps.control || !validateReviewed(r,this.deps.control,expected))) return void (outcome="stale_review");
      if (r.phase === "RUNNING") return void (outcome = "not_ready");
      if (r.phase === "EXPIRED") return void (outcome = "expired");
      if (r.phase !== "AWAITING_APPROVAL") return void (outcome = r.approval?.decision ? "already_decided" : "closed");
      const approvers = r.approval?.approvers ?? [];
      if (approvers.length && !approvers.includes(cmd.userId)) {
        this.event(r, `decision by ${cmd.userId} refused: not an approver`);
        return void (outcome = "forbidden");
      }
      outcome = "recorded";
      r.approval = { ...r.approval!, decision: cmd.decision, decidedBy: cmd.userId, decidedAt: new Date(this.now()).toISOString() };
      if (cmd.decision === "approve") {
        r.phase = "APPROVED";
        this.event(r, `approved by ${cmd.userId}`);
      } else {
        r.phase = "REJECTED";
        for (const a of r.actions) if (a.status === "pending_approval") a.status = "rejected";
        this.event(r, `rejected by ${cmd.userId}`);
      }
    });
    if (outcome === "recorded" && cmd.decision === "approve") {
      const job = this.drive(cmd.runId);
      if (cmd.wait !== false) await job;
    }
    const latest = (await this.load(cmd.runId)) ?? updated!;
    return { status: outcome === "forbidden" ? 403 : outcome === "stale_review" ? 409 : 200, body: { ...this.view(latest), result: outcome } };
  }

  private async cancel(cmd: Extract<Command, { action: "cancel" }>): Promise<Reply> {
    if (!(await this.load(cmd.runId))) return notFound(cmd.runId);
    let outcome = "not_cancellable";
    const run = await this.mutate(cmd.runId, (r) => {
      if (r.phase === "AWAITING_APPROVAL" || r.phase === "WAITING") {
        r.phase = "CANCELLED";
        delete r.wakeAt;
        for (const a of r.actions) if (a.status === "pending_approval" || isWaiting(a)) a.status = "skipped";
        this.event(r, `cancelled by ${cmd.userId}`);
        outcome = "cancelled";
      } else if (r.phase === "RUNNING" || r.phase === "APPROVED") {
        r.cancelRequested = true;
        this.event(r, `cancel requested by ${cmd.userId}`);
        outcome = "cancelling";
      }
    });
    return { status: 200, body: { ...this.view(run!), result: outcome } };
  }

  private async resume(cmd: Extract<Command, { action: "resume" }>): Promise<Reply> {
    const run = await this.load(cmd.runId);
    if (!run) return notFound(cmd.runId);
    const repairable = (run.phase === "AWAITING_APPROVAL" || run.phase === "DONE") && run.actions.some((a) => a.status === "failed");
    if (run.phase === "WAITING") {
      const job = this.drive(cmd.runId);
      if (cmd.wait !== false) await job;
      return { status: 200, body: { ...this.view((await this.load(cmd.runId))!), result: "resumed" } };
    }
    if (run.phase !== "RUNNING" && run.phase !== "APPROVED" && !repairable) return { status: 200, body: { ...this.view(run), result: "nothing_to_resume" } };
    const stale = this.now() - Date.parse(run.updatedAt) > (this.deps.staleMs ?? 60_000);
    if (!repairable && !stale && !run.lastError && !this.driving.has(cmd.runId)) {
      // Fresh and not ours: another container is probably driving it.
      return { status: 200, body: { ...this.view(run), result: "in_progress" } };
    }
    const job = this.drive(cmd.runId);
    if (cmd.wait !== false) await job;
    return { status: 200, body: { ...this.view((await this.load(cmd.runId))!), result: "resumed" } };
  }

  /** Re-reads every applied effect from its provider and records match / drift / missing. */
  private async reconcile(runId: string): Promise<Reply> {
    const run = await this.load(runId);
    if (!run) return notFound(runId);
    const ctx = this.context(run);
    const planned = new Map(this.workflow.plan(ctx, this.results(run)).map((p) => [p.id, p]));
    const applied = Object.fromEntries(run.actions.filter((a) => a.ref).map((a) => [a.id, { ref: a.ref!, detail: a.detail }]));
    const checks = await Promise.all(
      run.actions
        .filter((a) => a.status === "applied" && a.ref)
        .map(async (a) => {
          const p = planned.get(a.id);
          let res: ActionRecord["reconcile"];
          if (!p?.reconcile) res = { status: "unverifiable", detail: "no read-back for this action", checkedAt: "" };
          else {
            try {
              res = { ...(await p.reconcile({ ...ctx, applied } as ActionContext<I>, { ref: a.ref!, detail: a.detail })), checkedAt: "" };
            } catch (err) {
              const missing = errorCode(err).endsWith(":not_found");
              res = { status: missing ? "missing" : "unverifiable", detail: errorMessage(err), checkedAt: "" };
            }
          }
          return [a.id, { ...res, checkedAt: new Date(this.now()).toISOString() }] as const;
        }),
    );
    const byId = new Map(checks);
    const updated = await this.mutate(runId, (r) => {
      for (const a of r.actions) if (byId.has(a.id)) a.reconcile = byId.get(a.id);
      const tally = [...byId.values()].reduce<Record<string, number>>((t, c) => ((t[c.status] = (t[c.status] ?? 0) + 1), t), {});
      this.event(r, `reconciled: ${JSON.stringify(tally)}`);
    });
    return { status: 200, body: this.view(updated!) };
  }

  private async expireIfDue(run: RunRecord): Promise<RunRecord> {
    if (run.phase !== "AWAITING_APPROVAL" || !run.approval || Date.parse(run.approval.expiresAt) > this.now()) return run;
    return (await this.mutate(run.runId, (r) => {
      if (r.phase !== "AWAITING_APPROVAL") return;
      r.phase = "EXPIRED";
      delete r.wakeAt;
      for (const a of r.actions) if (a.status === "pending_approval" || isWaiting(a)) a.status = "skipped";
      this.event(r, "approval window expired");
    }))!;
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  private context(run: RunRecord): RunContext<I> {
    return {
      runId: run.runId,
      input: run.input as I,
      providers: this.deps.providers(run.correlation),
      drafter: this.deps.drafter,
      log: this.deps.log.child({ runId: run.runId, workflow: run.workflow }),
      startedAt: new Date(run.createdAt),
      checkpoint: this.checkpoints(run.runId),
    };
  }

  private checkpoints(runId: string): Checkpoints {
    const store = this.deps.store;
    const key = (k: string) => `ckpt#${runId}#${k}`;
    return {
      async load<T>(k: string) {
        return (await store.get(key(k)))?.value as T | undefined;
      },
      async save(k: string, value: unknown) {
        const cur = await store.get(key(k));
        if (cur) await store.replace({ ...cur, value });
        else if (!(await store.create({ pk: key(k), value }))) await store.replace({ ...(await store.get(key(k)))!, value });
      },
    };
  }

  private results(run: RunRecord): AgentResults {
    return {
      ok: Object.fromEntries(run.agents.filter((a) => a.status === "ok").map((a) => [a.name, a.output])),
      status: Object.fromEntries(run.agents.map((a) => [a.name, a.status])),
    };
  }

  async load(runId: string): Promise<RunRecord | undefined> {
    return (await this.deps.store.get(pk(runId))) as RunRecord | undefined;
  }

  /** Read-modify-write with compare-and-swap on `version`, retried on contention. */
  private async mutate(runId: string, fn: (r: RunRecord) => void): Promise<RunRecord | undefined> {
    for (let i = 0; i < 20; i++) {
      const cur = await this.load(runId);
      if (!cur) return undefined;
      const previous=structuredClone(cur);
      fn(cur);
      if(this.deps.control)checkpoint(previous,cur,this.deps.control,new Date(this.now()).toISOString());
      cur.updatedAt = new Date(this.now()).toISOString();
      if (await this.deps.store.replace(cur as unknown as Item)) {
        this.emitControl(cur);
        const saved = { ...cur, version: (cur.version ?? 0) + 1 };
        if ((cur as RunRecord & { auditTail?: AuditEntry[] }).auditTail?.length) await this.flushAudit(saved);
        return saved;
      }
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 20));
    }
    throw new Error(`run ${runId}: too much write contention`);
  }

  private event(r: RunRecord, msg: string) {
    const at = new Date(this.now()).toISOString();
    r.events.push({ at, msg });
    if (r.events.length > MAX_EVENTS) r.events.splice(0, r.events.length - MAX_EVENTS);
    if (this.workflow.audit) {
      // Kit v2: hash chain over every event; flushed to audit#<run>#<seq> items after the write commits.
      const prev = r.audit ?? { seq: 0, head: genesis(r.runId) };
      const entry = { seq: prev.seq + 1, at, msg };
      const head = chain(prev.head, entry);
      r.audit = { seq: entry.seq, head };
      (r as RunRecord & { auditTail?: AuditEntry[] }).auditTail = [...((r as RunRecord & { auditTail?: AuditEntry[] }).auditTail ?? []), { ...entry, hash: head }];
    }
  }

  /** Kit v2: waiting statuses become WAITING (with the next wake time), everything else DONE. */
  private settle(r: RunRecord) {
    if (r.actions.some(isWaiting)) {
      r.phase = "WAITING";
      setWake(r);
      this.event(r, `waiting until ${r.wakeAt ?? "a signal"}`);
    } else {
      r.phase = "DONE";
      delete r.wakeAt;
      this.event(r, `done (${outcome(r)})`);
    }
  }

  private async signal(cmd: Extract<Command, { action: "signal" }>): Promise<Reply> {
    const run = await this.load(cmd.runId);
    if (!run) return notFound(cmd.runId);
    const ctx = this.context(run);
    const p = this.workflow.plan(ctx, this.results(run)).find((x) => x.id === cmd.actionId);
    const rec = run.actions.find((a) => a.id === cmd.actionId);
    if (!p || !rec || !p.awaitSignal) return { status: 404, body: { result: "no_such_signal", runId: cmd.runId, actionId: cmd.actionId } };
    const w = p.awaitSignal;
    const sameAsOther = w.distinctFrom?.some((id) => run.actions.find((a) => a.id === id)?.signal?.by === cmd.userId);
    if ((w.from?.length && !w.from.includes(cmd.userId)) || w.notFrom?.includes(cmd.userId) || sameAsOther) {
      await this.mutate(cmd.runId, (r) => this.event(r, `signal for ${cmd.actionId} by ${cmd.userId} refused`));
      return { status: 403, body: { ...this.view((await this.load(cmd.runId))!), result: "forbidden" } };
    }
    let result = "recorded";
    await this.mutate(cmd.runId, (r) => {
      const a = r.actions.find((x) => x.id === cmd.actionId)!;
      if (CLOSED.includes(r.phase)) return void (result = "closed");
      if (a.signal) return void (result = a.signal.value === cmd.value ? "already_signalled" : "conflict");
      if (!isWaiting(a) && a.status !== "planned" && a.status !== "pending_approval") return void (result = "not_waiting");
      a.signal = { value: cmd.value, by: cmd.userId, at: new Date(this.now()).toISOString(), ...(cmd.note ? { note: cmd.note } : {}) };
      if (cmd.value === "reject") a.status = "rejected";
      this.event(r, `signal ${cmd.value} for ${cmd.actionId} by ${cmd.userId}`);
      if (r.phase === "WAITING" || r.phase === "AWAITING_APPROVAL") setWake(r);
    });
    if (result === "recorded") {
      const job = this.drive(cmd.runId);
      if (cmd.wait !== false) await job;
    }
    const latest = (await this.load(cmd.runId))!;
    return { status: result === "conflict" ? 409 : 200, body: { ...this.view(latest), result } };
  }

  /** Wakes every run whose timer or signal deadline is due; also expires approvals that ran out. */
  private async tick(wait: boolean): Promise<Reply> {
    const now = this.now();
    const all = (await this.deps.store.list("run#")) as unknown as RunRecord[];
    const due = all.filter((r) => (r.phase === "WAITING" || r.phase === "AWAITING_APPROVAL") && r.wakeAt && Date.parse(r.wakeAt) <= now);
    for (const r of all.filter((x) => x.phase === "AWAITING_APPROVAL")) await this.expireIfDue(r);
    const jobs = due.map((r) => this.drive(r.runId));
    if (wait) await Promise.all(jobs);
    return { status: 200, body: { woken: due.map((r) => r.runId) } };
  }

  private async evidence(runId: string): Promise<Reply> {
    const run = await this.load(runId);
    if (!run) return notFound(runId);
    if (!this.workflow.audit) return { status: 404, body: { result: "no_audit_trail", runId } };
    await this.flushAudit(run);
    const items = ((await this.deps.store.list(`audit#${runId}#`)) as unknown as AuditEntry[]).sort((a, b) => a.seq - b.seq);
    let head = genesis(runId);
    let verified = true;
    let brokenAt: number | null = null;
    for (const e of items) {
      const next = chain(head, { seq: e.seq, at: e.at, msg: e.msg });
      if (next !== e.hash || (brokenAt === null && e.seq !== (items.indexOf(e) + 1))) {
        verified = false;
        brokenAt ??= e.seq;
      }
      head = e.hash;
    }
    const complete = items.length === (run.audit?.seq ?? 0) && head === (run.audit?.head ?? genesis(runId));
    return { status: 200, body: { runId, entries: items.map(({ seq, at, msg, hash }) => ({ seq, at, msg, hash })), head: run.audit?.head ?? null, verified: verified && complete, brokenAt } };
  }

  /** Persists audit entries that are still in the run record, then drops them from it. */
  private async flushAudit(run: RunRecord) {
    const tail = (run as RunRecord & { auditTail?: AuditEntry[] }).auditTail ?? [];
    if (!tail.length) return;
    for (const e of tail) await this.deps.store.create({ pk: `audit#${run.runId}#${String(e.seq).padStart(8, "0")}`, ...e });
    const flushed = new Set(tail.map((e) => e.seq));
    for (let i = 0; i < 20; i++) {
      const cur = await this.load(run.runId);
      if (!cur) return;
      const t = (cur as RunRecord & { auditTail?: AuditEntry[] }).auditTail ?? [];
      (cur as RunRecord & { auditTail?: AuditEntry[] }).auditTail = t.filter((e) => !flushed.has(e.seq));
      if (await this.deps.store.replace(cur as unknown as Item)) return;
    }
  }

  private emitControl(r:RunRecord){if(!this.deps.control||!r.control||!sameScope(r.control.scope,this.deps.control.scope))return;for(const event of r.control.events){const id=String(event.event_id);if(this.emittedControl.has(id))continue;try{this.deps.controlSink?.(event);this.emittedControl.add(id);}catch{this.deps.log.warn("Control telemetry emission unavailable",{runId:r.runId});}}}
  async controlRuns(){const rows=(await this.deps.store.list("run#")) as unknown as RunRecord[];return rows.filter(r=>r.control&&this.deps.control&&sameScope(r.control.scope,this.deps.control.scope));}
  async decideReviewed(runId:string,reviewer:string,userId:string,decision:string,revision:string,policyVersion:string){
   if(!this.deps.control||this.deps.control.reviewerMap[reviewer]!==userId)return {status:403,body:{error:"Reviewer refused"}};
   const r=await this.load(runId);if(!r||!validateReviewed(r,this.deps.control,{revision,policyVersion}))return {status:409,body:{error:"Reviewed request changed"}};
   return this.decide({action:"decide",runId,userId,decision:decision==="approved"?"approve":"reject",wait:false},{revision,policyVersion});
  }

  /** What `status` returns: everything a control plane needs to render and steer the run. */
  view(r: RunRecord) {
    const count = (s: string) => r.actions.filter((a) => a.status === s).length;
    return {
      runId: r.runId,
      workflow: r.workflow,
      metadata: deploymentMetadata(),
      org: r.org,
      team: r.team,
      phase: r.phase,
      closed: CLOSED.includes(r.phase),
      outcome: outcome(r),
      requestedBy: r.requestedBy,
      labels: r.labels,
      duplicateStarts: r.duplicateStarts,
      agents: r.agents.map(({ name, status, summary, error, errorCode, durationMs }) => ({ name, status, summary, error, errorCode, durationMs })),
      // `reconciled` flattens the last read-back for consumers that can't reach into objects.
      actions: r.actions.map((a) => ({ ...a, reconciled: a.reconcile?.status ?? null })),
      counts: {
        applied: count("applied"),
        failed: count("failed"),
        pendingApproval: count("pending_approval"),
        skipped: count("skipped"),
        rejected: count("rejected"),
        scheduled: count("scheduled"),
        awaitingSignal: count("awaiting_signal"),
        compensated: count("compensated"),
      },
      wakeAt: r.wakeAt ?? null,
      audit: r.audit ?? null,
      approval: r.approval,
      output: r.output ?? {},
      lastError: r.lastError,
      events: r.events,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  /** Runs carrying all of `labels` (verifier and admin reads). */
  async findByLabels(labels: Record<string, string>) {
    const all = (await this.deps.store.list("run#")) as unknown as RunRecord[];
    return all
      .filter((r) => Object.entries(labels).every(([k, v]) => r.labels?.[k] === v))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((r) => this.view(r));
  }
}

const pk = (runId: string) => `run#${runId}`;

function notFound(runId: string): Reply {
  return { status: 404, body: { result: "not_found", runId } };
}

function toRecord<I>(p: PlannedAction<I>): ActionRecord {
  return {
    id: p.id,
    kind: p.kind,
    provider: p.provider,
    agent: p.agent,
    gate: p.gate,
    status: p.gate === "approval" ? "pending_approval" : p.waitUntil ? "scheduled" : p.awaitSignal ? "awaiting_signal" : "planned",
    summary: p.summary,
    attempts: 0,
    ...(p.waitUntil ? { waitUntil: p.waitUntil } : {}),
    ...(p.awaitSignal?.deadline ? { signalDeadline: p.awaitSignal.deadline } : {}),
  };
}

interface AuditEntry {
  seq: number;
  at: string;
  msg: string;
  hash: string;
}

const genesis = (runId: string) => createHash("sha256").update(`audit:${runId}`).digest("hex");
const chain = (prev: string, e: { seq: number; at: string; msg: string }) => createHash("sha256").update(prev).update(JSON.stringify(e)).digest("hex");

const SETTLED = new Set<ActionStatus>(["applied", "rejected", "skipped", "failed", "compensated"]);

function isWaiting(a: ActionRecord) {
  return a.status === "scheduled" || a.status === "awaiting_signal";
}

/** Next time the run must be looked at: the earliest timer or signal deadline still open. */
function setWake(r: RunRecord) {
  const times = r.actions.filter(isWaiting).flatMap((a) => [a.status === "scheduled" ? a.waitUntil : undefined, a.status === "awaiting_signal" ? (a.signal ? new Date(0).toISOString() : a.signalDeadline) : undefined]).filter((t): t is string => !!t);
  if (times.length) r.wakeAt = times.sort()[0];
  else delete r.wakeAt;
}

/** ok: everything attempted worked · partial: some agent or action failed · failed: nothing useful happened. */
function outcome(r: RunRecord): "ok" | "partial" | "failed" | "pending" | "compensated" {
  if (r.phase === "RUNNING") return "pending";
  if (r.actions.some((a) => a.status === "compensated" || a.compensation)) return "compensated";
  const agentFail = r.agents.some((a) => a.status === "failed");
  const actFail = r.actions.some((a) => a.status === "failed");
  const anyOk = r.agents.some((a) => a.status === "ok") || r.actions.some((a) => a.status === "applied");
  if (!anyOk) return "failed";
  return agentFail || actFail ? "partial" : "ok";
}

function deploymentMetadata() {
  return { organization: process.env.WORKFLOW_ORGANIZATION ?? "Acme", company: process.env.WORKFLOW_COMPANY_NAME ?? "Acme Corporation", environment: process.env.WORKFLOW_ENVIRONMENT ?? "unconfigured", owner: process.env.WORKFLOW_OWNER ?? "unassigned", department: process.env.WORKFLOW_DEPARTMENT ?? "unassigned", ownerTeam: process.env.WORKFLOW_OWNER_TEAM ?? "unassigned", oncall: process.env.WORKFLOW_ONCALL_STATUS ?? "unassigned", version: process.env.WORKFLOW_DEPLOYMENT_VERSION ?? "unversioned", sourceCommit: process.env.WORKFLOW_SOURCE_COMMIT ?? "unrecorded" };
}
