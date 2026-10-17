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
}

export interface ActionContext<I> extends RunContext<I> {
  /** Receipts of actions applied earlier in this run, by action id. */
  applied: Record<string, ActionReceipt>;
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
  /** Static catalogue for `describe`: every action kind this workflow may take. */
  catalog: { kind: string; provider: ProviderName; gate: Gate; description: string }[];
}

// ---------------------------------------------------------------------------
// What the engine stores
// ---------------------------------------------------------------------------

export type Phase = "RUNNING" | "AWAITING_APPROVAL" | "APPROVED" | "DONE" | "REJECTED" | "EXPIRED" | "CANCELLED" | "FAILED";
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

export type ActionStatus = "pending_approval" | "planned" | "applied" | "failed" | "skipped" | "rejected";

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
}

export interface RunRecord {
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
  cancelRequested?: boolean;
  duplicateStarts: number;
  lastError?: string;
  events: { at: string; msg: string }[];
  createdAt: string;
  updatedAt: string;
}
