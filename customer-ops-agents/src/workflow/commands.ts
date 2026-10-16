import { z } from "zod";

// The control API LoopLabs (or anything that can call AgentCore's
// InvokeAgentRuntime) speaks. One JSON object per POST /invocations.

const RunId = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9_.:-]+$/, "runId may contain letters, digits and _ . : -");

export const CommandSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("start"),
    /** Idempotency key. Use something stable from the trigger, e.g. the Slack event_id. Generated if omitted. */
    runId: RunId.optional(),
    requestText: z.string().min(1).max(8_000),
    requestedBy: z.object({ userId: z.string().min(1), userName: z.string().optional() }),
    slack: z.object({ channel: z.string().min(1), threadTs: z.string().min(1) }).optional(),
    /** Block until the run reaches approval (or a terminal state) instead of returning immediately. */
    wait: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("decide"),
    runId: RunId,
    decision: z.enum(["approve", "reject"]),
    /** Who clicked. Checked against APPROVER_USER_IDS when that list is set. */
    userId: z.string().min(1),
    wait: z.boolean().optional(),
  }),
  z.object({ action: z.literal("status"), runId: RunId }),
  z.object({ action: z.literal("resume"), runId: RunId, wait: z.boolean().optional() }),
  z.object({ action: z.literal("cancel"), runId: RunId, userId: z.string().min(1) }),
  /** Expire overdue approvals and resume stalled runs. Call it on a schedule (e.g. every 5 minutes). */
  z.object({ action: z.literal("sweep"), limit: z.number().int().min(1).max(100).optional() }),
]);

export type Command = z.infer<typeof CommandSchema>;
