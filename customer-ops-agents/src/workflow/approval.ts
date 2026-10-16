import type { SlackBlock } from "../providers/slack";
import { type HandoffState, type QuoteResult, agentData } from "../types";

export const APPROVAL_TTL_MS = 24 * 3600_000;

const money = (cents: number, cur: string) => `${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })} ${cur.toUpperCase()}`;

/** What the human sees before approving. Shared by the Slack card and `status`. */
export function approvalSummary(s: HandoffState): string {
  const q = agentData<QuoteResult>(s, "quote");
  return [
    `*Approval needed* — ${s.intake.summary}`,
    `*Handoff:* ${s.handoff.summary}`,
    q && `*Quote:* ${q.lines.map((l) => `${l.quantity}× ${l.product}`).join(", ")} → *${money(q.totalCents, q.currency)}*${q.discountPct ? ` (${q.discountPct}% off)` : ""}`,
    q?.needsDiscountApproval && `:warning: Discount ${q.discountPct}% exceeds the auto-approve cap.`,
    q?.unmatched.length && `:grey_question: Not quoted (no catalog match): ${q.unmatched.join(", ")}`,
    `*On approve:* ${s.handoff.actions.join(", ")}`,
    `*Email to customer:* _${s.handoff.customerEmail.subject}_`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Slack card with Approve / Reject. LoopLabs receives the click (action_id
 * `approve` | `reject`, value = runId) and forwards it as a `decide` command.
 */
export function approvalBlocks(s: HandoffState): SlackBlock[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: approvalSummary(s) } },
    {
      type: "actions",
      block_id: "approval",
      elements: [
        { type: "button", style: "primary", text: { type: "plain_text", text: "Approve & send" }, action_id: "approve", value: s.runId },
        { type: "button", style: "danger", text: { type: "plain_text", text: "Reject" }, action_id: "reject", value: s.runId },
      ],
    },
  ];
}
