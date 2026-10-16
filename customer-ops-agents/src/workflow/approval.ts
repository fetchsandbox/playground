import type { Deps } from "../deps";
import { once } from "../lib/idempotency";
import type { SlackBlock } from "../providers/slack";
import { ttlFromNow } from "../lib/store";
import { type ApprovalDecision, type HandoffState, type QuoteResult, agentData } from "../types";

export const APPROVAL_TTL_MS = 24 * 3600_000;
export const approvalKey = (runId: string) => `approval#${runId}`;

/** Step Functions callback surface (SendTaskSuccess). Faked in tests. */
export interface TaskCallbacks {
  /** Throws an error named TaskTimedOut / InvalidToken / TaskDoesNotExist when the wait is over. */
  success(taskToken: string, output: ApprovalDecision): Promise<void>;
}

const money = (cents: number, cur: string) => `${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })} ${cur.toUpperCase()}`;

function approvalBlocks(s: HandoffState): SlackBlock[] {
  const q = agentData<QuoteResult>(s, "quote");
  const lines = [
    `*Approval needed* — ${s.intake.summary}`,
    `*Handoff:* ${s.handoff.summary}`,
    q && `*Quote:* ${q.lines.map((l) => `${l.quantity}× ${l.product}`).join(", ")} → *${money(q.totalCents, q.currency)}*${q.discountPct ? ` (${q.discountPct}% off)` : ""}`,
    q?.needsDiscountApproval && `:warning: Discount ${q.discountPct}% exceeds the auto-approve cap.`,
    q?.unmatched.length && `:grey_question: Not quoted (no catalog match): ${q.unmatched.join(", ")}`,
    `*On approve:* ${s.handoff.actions.join(", ")}`,
    `*Email to customer:* _${s.handoff.customerEmail.subject}_`,
  ].filter(Boolean);
  return [
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
    {
      type: "actions",
      block_id: "approval",
      elements: [
        // Only the runId travels through Slack; the task token stays in DynamoDB.
        { type: "button", style: "primary", text: { type: "plain_text", text: "Approve & send" }, action_id: "approve", value: s.runId },
        { type: "button", style: "danger", text: { type: "plain_text", text: "Reject" }, action_id: "reject", value: s.runId },
      ],
    },
  ];
}

/**
 * Runs as a `.waitForTaskToken` task: store the token, post the buttons, and
 * return. The execution stays paused until a click calls `decideApproval`.
 */
export async function requestApproval(s: HandoffState, taskToken: string, d: Deps): Promise<void> {
  const pk = approvalKey(s.runId);
  const created = await d.store.put(
    { pk, status: "PENDING", taskToken, channel: s.slack.channel, threadTs: s.slack.threadTs, expiresAt: d.now() + APPROVAL_TTL_MS, ttl: ttlFromNow(7 * 86_400, d.now()) },
    { kind: "notExists" },
  );
  if (!created) {
    // Step Functions retried this task: each attempt gets a fresh token, so
    // swap it in — but only while nobody has decided yet.
    await d.store.update(pk, { taskToken }, { kind: "equals", attrs: { status: "PENDING" } });
  }
  const msg = await once(d.store, `${s.runId}:slack:approval`, () =>
    d.chat.post(s.slack.channel, `Approval needed: ${s.intake.summary}`, { threadTs: s.slack.threadTs, blocks: approvalBlocks(s) }),
  );
  await d.store.update(pk, { messageTs: msg.ts });
}

export type DecideOutcome =
  | { outcome: "recorded"; status: "APPROVED" | "REJECTED" }
  | { outcome: "already_decided"; status: string; decidedBy?: string }
  | { outcome: "expired" }
  | { outcome: "not_found" }
  | { outcome: "forbidden" };

/**
 * Handle a button click. Two approvers clicking at once, a double-click, or a
 * click racing the 24h timeout all resolve to exactly one decision: the
 * conditional PENDING → APPROVED/REJECTED update is the arbiter.
 */
export async function decideApproval(
  runId: string,
  decision: ApprovalDecision["decision"],
  userId: string,
  d: Deps,
  callbacks: TaskCallbacks,
): Promise<DecideOutcome> {
  if (d.config.approverUserIds.length && !d.config.approverUserIds.includes(userId)) return { outcome: "forbidden" };
  const pk = approvalKey(runId);
  const status = decision === "approve" ? "APPROVED" : "REJECTED";

  const won = await d.store.update(pk, { status, decidedBy: userId, decidedAt: d.now() }, { kind: "equals", attrs: { status: "PENDING" } });
  if (!won) {
    const rec = await d.store.get(pk);
    if (!rec) return { outcome: "not_found" };
    if (rec.status === "EXPIRED") return { outcome: "expired" };
    return { outcome: "already_decided", status: String(rec.status), decidedBy: rec.decidedBy as string | undefined };
  }

  // Re-read after winning: the token can no longer be swapped (that requires PENDING).
  const rec = await d.store.get(pk);
  try {
    await callbacks.success(String(rec?.taskToken), { decision, decidedBy: userId });
  } catch (err) {
    const name = (err as Error).name;
    if (name === "TaskTimedOut" || name === "InvalidToken" || name === "TaskDoesNotExist") {
      await d.store.update(pk, { status: "EXPIRED" }, { kind: "equals", attrs: { status } });
      return { outcome: "expired" };
    }
    // Unknown failure: roll back so someone can click again.
    await d.store.update(pk, { status: "PENDING" }, { kind: "equals", attrs: { status, decidedBy: userId } });
    throw err;
  }
  return { outcome: "recorded", status };
}
