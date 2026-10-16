import type { Deps } from "../deps";
import { once } from "../lib/idempotency";
import type { DispatchState, HandoffState, WorkflowInput } from "../types";
import { approvalKey } from "./approval";

export type NotifyEvent =
  | { kind: "done"; state: DispatchState }
  | { kind: "rejected"; state: HandoffState & { approval: { decidedBy: string } } }
  | { kind: "expired"; state: HandoffState }
  | { kind: "failed"; state: WorkflowInput & { error?: { Error?: string; Cause?: string } } };

function causeText(cause: string | undefined) {
  if (!cause) return "";
  try {
    const c = JSON.parse(cause) as { errorMessage?: string };
    return c.errorMessage ?? cause;
  } catch {
    return cause;
  }
}

/** Final word in the Slack thread for every terminal path of the state machine. */
export async function runNotify(e: NotifyEvent, d: Deps): Promise<void> {
  const s = e.state;
  let text: string;
  switch (e.kind) {
    case "done": {
      const icon = { done: "✅", skipped: "⏭️", failed: "❌" } as const;
      text = `*Done.*\n${e.state.dispatch.map((o) => `${icon[o.status]} ${o.action}: ${o.detail}`).join("\n")}`;
      break;
    }
    case "rejected":
      text = `🛑 Rejected by <@${e.state.approval.decidedBy}>. Nothing was sent to the customer. Draft quote and CRM note were kept for reference.`;
      break;
    case "expired": {
      text = "⌛ Approval window expired; nothing was sent. Re-run the request to start again.";
      // Close the window in our own store too, and take the buttons off the message.
      await d.store.update(approvalKey(s.runId), { status: "EXPIRED" }, { kind: "equals", attrs: { status: "PENDING" } });
      const rec = await d.store.get(approvalKey(s.runId));
      if (typeof rec?.messageTs === "string") await d.chat.update(s.slack.channel, rec.messageTs, "⌛ This approval expired.", []);
      break;
    }
    case "failed":
      text = `⚠️ Workflow stopped: ${causeText(e.state.error?.Cause) || e.state.error?.Error || "unknown error"}`;
      break;
  }
  await once(d.store, `${s.runId}:slack:notify:${e.kind}`, () => d.chat.post(s.slack.channel, text, { threadTs: s.slack.threadTs }));
}
