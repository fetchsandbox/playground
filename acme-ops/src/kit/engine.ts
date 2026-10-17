import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ProviderFactory } from "../providers";
import type { Drafter } from "./drafter";
import { errorCode, errorMessage } from "./errors";
import type { Logger } from "./log";
import type { Item, KvStore } from "./store";
import {
  type ActionContext,
  type ActionReceipt,
  type ActionRecord,
  type AgentRecord,
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
]);
export type Command = z.infer<typeof CommandSchema>;

/** Engine answer: HTTP status for the server plus a JSON body. */
export interface Reply {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON reply, consumed over HTTP
  body: Record<string, any>;
}

export interface EngineDeps {
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
      commands: ["describe", "start", "status", "decide", "cancel", "resume", "reconcile"],
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
      createdAt: at,
      updatedAt: at,
    };
    if (!(await this.deps.store.create(run as unknown as Item))) {
      const existing = await this.mutate(runId, (r) => {
        r.duplicateStarts++;
        this.event(r, "duplicate start ignored");
      });
      return { status: 200, body: { ...this.view(existing!), duplicate: true } };
    }
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

      await this.execute(runId, ctx, planned, "auto");
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
          this.event(r, "awaiting approval");
        } else {
          r.phase = "DONE";
          this.event(r, `done (${outcome(r)})`);
        }
      }))!;
      return;
    }

    if (run.phase === "APPROVED") {
      await this.execute(runId, ctx, this.workflow.plan(ctx, this.results(run)), "approval");
      await this.mutate(runId, (r) => {
        if (r.phase !== "APPROVED") return;
        r.phase = "DONE";
        this.event(r, `done (${outcome(r)})`);
      });
      return;
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
  private async execute(runId: string, ctx: RunContext<I>, planned: PlannedAction<I>[], gate: "auto" | "approval") {
    for (const p of planned.filter((x) => x.gate === gate)) {
      const run = (await this.load(runId))!;
      if (run.cancelRequested || run.phase === "CANCELLED") {
        await this.mutate(runId, (r) => {
          for (const a of r.actions) if (a.status === "planned" || a.status === "pending_approval") a.status = "skipped";
          r.phase = "CANCELLED";
          this.event(r, "cancelled");
        });
        return;
      }
      const rec = run.actions.find((a) => a.id === p.id);
      if (!rec || rec.status === "applied" || rec.status === "skipped" || rec.status === "rejected") continue;

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

      const applied = Object.fromEntries(
        run.actions.filter((a) => a.status === "applied" && a.ref).map((a) => [a.id, { ref: a.ref!, detail: a.detail } satisfies ActionReceipt]),
      );
      try {
        const receipt = await p.execute({ ...ctx, applied } as ActionContext<I>);
        await this.deps.store.replace({ ...(await this.deps.store.get(claimKey))!, state: "applied", ref: receipt.ref, detail: receipt.detail ?? {} });
        await this.updateAction(runId, p.id, { status: "applied", ref: receipt.ref, detail: receipt.detail, appliedAt: new Date(this.now()).toISOString() });
      } catch (err) {
        // Release the claim so a later resume can retry this one effect.
        await this.deps.store.delete(claimKey);
        ctx.log.warn("action failed", { action: p.id, err: errorMessage(err) });
        await this.updateAction(runId, p.id, { status: "failed", error: errorMessage(err), errorCode: errorCode(err) });
      }
    }
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

  private async decide(cmd: Extract<Command, { action: "decide" }>): Promise<Reply> {
    let run = await this.load(cmd.runId);
    if (!run) return notFound(cmd.runId);
    run = await this.expireIfDue(run);
    let outcome: string | undefined;
    const updated = await this.mutate(cmd.runId, (r) => {
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
    return { status: outcome === "forbidden" ? 403 : 200, body: { ...this.view(latest), result: outcome } };
  }

  private async cancel(cmd: Extract<Command, { action: "cancel" }>): Promise<Reply> {
    if (!(await this.load(cmd.runId))) return notFound(cmd.runId);
    let outcome = "not_cancellable";
    const run = await this.mutate(cmd.runId, (r) => {
      if (r.phase === "AWAITING_APPROVAL") {
        r.phase = "CANCELLED";
        for (const a of r.actions) if (a.status === "pending_approval") a.status = "skipped";
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
      for (const a of r.actions) if (a.status === "pending_approval") a.status = "skipped";
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
      fn(cur);
      cur.updatedAt = new Date(this.now()).toISOString();
      if (await this.deps.store.replace(cur as unknown as Item)) return { ...cur, version: (cur.version ?? 0) + 1 };
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 20));
    }
    throw new Error(`run ${runId}: too much write contention`);
  }

  private event(r: RunRecord, msg: string) {
    r.events.push({ at: new Date(this.now()).toISOString(), msg });
    if (r.events.length > MAX_EVENTS) r.events.splice(0, r.events.length - MAX_EVENTS);
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
      },
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
    status: p.gate === "approval" ? "pending_approval" : "planned",
    summary: p.summary,
    attempts: 0,
  };
}

/** ok: everything attempted worked · partial: some agent or action failed · failed: nothing useful happened. */
function outcome(r: RunRecord): "ok" | "partial" | "failed" | "pending" {
  if (r.phase === "RUNNING") return "pending";
  const agentFail = r.agents.some((a) => a.status === "failed");
  const actFail = r.actions.some((a) => a.status === "failed");
  const anyOk = r.agents.some((a) => a.status === "ok") || r.actions.some((a) => a.status === "applied");
  if (!anyOk) return "failed";
  return agentFail || actFail ? "partial" : "ok";
}

function deploymentMetadata() {
  return { organization: process.env.WORKFLOW_ORGANIZATION ?? "Acme", environment: process.env.WORKFLOW_ENVIRONMENT ?? "unconfigured", owner: process.env.WORKFLOW_OWNER ?? "unassigned", department: process.env.WORKFLOW_DEPARTMENT ?? "unassigned", ownerTeam: process.env.WORKFLOW_OWNER_TEAM ?? "unassigned", oncall: process.env.WORKFLOW_ONCALL_STATUS ?? "unassigned", version: process.env.WORKFLOW_DEPLOYMENT_VERSION ?? "unversioned", sourceCommit: process.env.WORKFLOW_SOURCE_COMMIT ?? "unrecorded" };
}
