import type { Deps } from "../deps";
import { type AgentResult, BillingAssessmentSchema, type BillingResult, type IntakeState } from "../types";

const SYSTEM = `You are a billing analyst. Given a customer's Stripe invoices and subscriptions (amounts in minor units),
assess account health and suggest next actions for a human. You cannot move money; only suggest.`;

/**
 * Read-only by design. It may run concurrently with the quote agent creating
 * the Stripe customer; seeing "no customer yet" in that window is correct
 * (the account has no billing history) so no lock is needed here.
 */
export async function runBilling(s: IntakeState, d: Deps): Promise<AgentResult<BillingResult>> {
  const customerId = await d.billing.findCustomer(s.intake.customer.email);
  if (!customerId) {
    return {
      agent: "billing",
      status: "ok",
      data: { stripeCustomerId: null, outstandingCents: 0, overdueInvoices: 0, activeSubscriptions: [], health: "good", notes: "No Stripe customer yet — new account, no billing history.", proposedActions: [] },
    };
  }

  const snap = await d.billing.snapshot(customerId);
  const nowSec = d.now() / 1000;
  const open = snap.invoices.filter((i) => i.status === "open");
  const outstandingCents = open.reduce((n, i) => n + i.amountRemaining, 0);
  const overdueInvoices = open.filter((i) => i.dueDate !== null && i.dueDate < nowSec).length;
  const activeSubscriptions = snap.subscriptions.filter((x) => ["active", "trialing", "past_due"].includes(x.status)).map((x) => `${x.id} (${x.status})`);

  const assessment = await d.llm.structured({
    task: "billing-assess",
    schema: BillingAssessmentSchema,
    effort: "low",
    system: SYSTEM,
    prompt: JSON.stringify({ request: s.intake.summary, computed: { outstandingCents, overdueInvoices }, ...snap }),
  });
  return { agent: "billing", status: "ok", data: { stripeCustomerId: customerId, outstandingCents, overdueInvoices, activeSubscriptions, ...assessment } };
}
