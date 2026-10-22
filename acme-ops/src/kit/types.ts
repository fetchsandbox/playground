import type { z } from "zod";
import type { ProviderName, Providers } from "../providers";
import type { Drafter } from "./drafter";
import type { Logger } from "./log";

// ---------------------------------------------------------------------------
// What a workflow author writes
// ---------------------------------------------------------------------------

export interface RunContext<I> {
  runId: string;
  input: I;
  providers: Providers;
  drafter: Drafter;
  log: Logger;
  /** Run creation time. Use it instead of Date.now() so plans stay reproducible. */
  startedAt: Date;
  /** Durable progress for long agents (Kit v2): a restart continues from the last saved value. */
  checkpoint: Checkpoints;
}

export interface Checkpoints {
  load<T>(key: string): Promise<T | undefined>;
  save(key: string, value: unknown): Promise<void>;
}

/** One agent of the parallel stage. Read-only: agents gather and judge, actions write. */
export interface AgentDef<I> {
  name: string;
  /** Providers the agent can't work without. Missing → the agent is `skipped`, not faked. */
  needs: ProviderName[];
  run(ctx: RunContext<I>): Promise<AgentOutput>;
}

export interface AgentOutput {
  /** One line for people (Slack, the control plane UI). */
  summary: string;
  data: unknown;
}

/** Outputs of finished agents by name. Failed or skipped agents are absent from `ok`. */
export interface AgentResults {
  ok: Record<string, unknown>;
  status: Record<string, AgentStatus>;
}

export type Gate = "auto" | "approval";

/** A side effect the plan wants. `id` must be stable for the same input + agent outputs. */
export interface PlannedAction<I> {
  id: string;
  kind: string;
  provider: ProviderName;
  agent: string;
  gate: Gate;
  /** What will happen, for the approval card and the audit trail. No secrets. */
  summary: Record<string, unknown>;
  execute(ctx: ActionContext<I>): Promise<ActionReceipt>;
  /** Re-read the provider and say whether the effect is still what we wrote. */
  reconcile?(ctx: ActionContext<I>, receipt: ActionReceipt): Promise<ReconcileResult>;

  // ---- Kit v2 (all optional; an action without them behaves as before) ----
  /** Durable timer: not executed before this ISO time. The run waits (phase WAITING) and a tick wakes it. */
  waitUntil?: string;
  /** Waits for a `signal` addressed to this action (a per-item decision, a callback, a confirmation). */
  awaitSignal?: AwaitSignal;
  /** Undo for this effect. Called in reverse order when a later action with onFailure "compensate" fails. */
  compensate?(ctx: ActionContext<I>, receipt: ActionReceipt): Promise<ActionReceipt | void>;
  /** "compensate": if this action fails, stop the run and undo every applied action that can be undone. */
  onFailure?: "continue" | "compensate";
}

export interface AwaitSignal {
  /** Users allowed to send the signal (empty or absent: anyone the control plane forwards). */
  from?: string[];
  /** Users who may never send it, e.g. the requester or whoever set the record up (segregation of duties). */
  notFrom?: string[];
  /** ISO time after which the default applies. */
  deadline?: string;
  /** What happens at the deadline without a signal. */
  onDeadline?: "approve" | "reject" | "fail";
}

export interface SignalRecord {
  value: "approve" | "reject";
  by: string;
  at: string;
  note?: string;
  /** True when the deadline's default, not a person, decided. */
  defaulted?: boolean;
}

export interface ActionContext<I> extends RunContext<I> {
  /** Receipts of actions applied earlier in this run, by action id. */
  applied: Record<string, ActionReceipt>;
  /** The signal this action waited for, if any. */
  signal?: SignalRecord;
  /** Every action's current status, for steps that depend on others (reminders, escalations). */
  statuses: Record<string, ActionStatus>;
}

export interface ActionReceipt {
  /** Provider object id (contact id, subscription id, message ts, ...). */
  ref: string;
  detail?: Record<string, unknown>;
}

export interface ReconcileResult {
  status: "match" | "drift" | "missing" | "unverifiable";
  detail?: string;
}

export interface WorkflowDef<I> {
  id: string;
  title: string;
  /** Owning organisation and team, surfaced to the control plane. */
  org: string;
  team: string;
  description: string;
  input: z.ZodType<I>;
  agents: AgentDef<I>[];
  /** Optional second stage that sees every agent's result (typically drafting). */
  compose?: { name: string; run(ctx: RunContext<I>, results: AgentResults): Promise<AgentOutput> };
  /** Pure: same input + same agent outputs → same actions. Re-run on approve/resume/reconcile. */
  plan(ctx: RunContext<I>, results: AgentResults): PlannedAction<I>[];
  /** The run's business output, shown in `status`. */
  output(ctx: RunContext<I>, results: AgentResults): Record<string, unknown>;
  /**
   * Provider events this runtime accepts (signed webhooks). The mapper treats the
   * event as a hint: it re-reads provider state and returns the run to start, or
   * null to acknowledge and ignore. Equal run ids make redeliveries one run.
   */
  events?: { stripe?(event: ProviderEvent, providers: Providers): Promise<EventStart | null> };
  /** Kit v2: how often waiting runs are woken in production (EventBridge Scheduler expression, e.g. "rate(5 minutes)"). */
  tickEvery?: string;
  /** Kit v2: keep a hash-chained audit trail of every event (SOC 2 / SOX evidence); see the `evidence` command. */
  audit?: boolean;
  /** Static catalogue for `describe`: every action kind this workflow may take. */
  catalog: { kind: string; provider: ProviderName; gate: Gate; description: string }[];
}

export interface ProviderEvent {
  id: string;
  type: string;
  data?: { object?: { id?: unknown } };
}

export interface EventStart {
  runId: string;
  input: unknown;
  /** Copy the labels of this earlier run (e.g. the order the payment belongs to). */
  labelsFromRun?: string;
}

// ---------------------------------------------------------------------------
// What the engine stores
// ---------------------------------------------------------------------------

export type Phase = "RUNNING" | "AWAITING_APPROVAL" | "APPROVED" | "WAITING" | "DONE" | "REJECTED" | "EXPIRED" | "CANCELLED" | "FAILED";
export const CLOSED: Phase[] = ["DONE", "REJECTED", "EXPIRED", "CANCELLED", "FAILED"];

export type AgentStatus = "ok" | "failed" | "skipped";

export interface AgentRecord {
  name: string;
  status: AgentStatus;
  summary?: string;
  output?: unknown;
  error?: string;
  errorCode?: string;
  durationMs: number;
}

export type ActionStatus = "pending_approval" | "planned" | "scheduled" | "awaiting_signal" | "applied" | "failed" | "skipped" | "rejected" | "compensated";

export interface ActionRecord {
  id: string;
  kind: string;
  provider: ProviderName;
  agent: string;
  gate: Gate;
  status: ActionStatus;
  summary: Record<string, unknown>;
  ref?: string;
  detail?: Record<string, unknown>;
  error?: string;
  errorCode?: string;
  attempts: number;
  appliedAt?: string;
  reconcile?: ReconcileResult & { checkedAt: string };
  /** Kit v2: when this action may run, the signal it got, and how it was undone. */
  waitUntil?: string;
  signalDeadline?: string;
  signal?: SignalRecord;
  compensation?: { status: "applied" | "failed" | "not_supported"; ref?: string; error?: string; at: string };
}

export interface RunRecord {
  control?: import("./looplabs-control").ControlState;
  pk: string;
  version?: number;
  runId: string;
  workflow: string;
  org: string;
  team: string;
  phase: Phase;
  input: unknown;
  requestedBy: { userId: string; userName?: string };
  labels: Record<string, string>;
  /** Correlation headers captured at start and replayed on every provider call. */
  correlation: Record<string, string>;
  agents: AgentRecord[];
  actions: ActionRecord[];
  output?: Record<string, unknown>;
  approval?: { approvers: string[]; expiresAt: string; decidedBy?: string; decision?: "approve" | "reject"; decidedAt?: string };
  /** Kit v2: earliest time a waiting run must be woken (timer or signal deadline). */
  wakeAt?: string;
  /** Kit v2: hash-chained audit trail head (entries are stored as audit#<run>#<seq>). */
  audit?: { seq: number; head: string };
  cancelRequested?: boolean;
  duplicateStarts: number;
  lastError?: string;
  events: { at: string; msg: string }[];
  createdAt: string;
  updatedAt: string;
}
