import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectionsCreditHold, tierFor } from "../src/workflows/collections-credit-hold";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

describe("collections tiers", () => {
  it("tiers by days overdue", () => {
    expect([tierFor(7), tierFor(30), tierFor(60)]).toEqual(["reminder", "firm", "final"]);
  });
});

describe("collections disputes", () => {
  let w: World;
  beforeEach(async () => {
    w = await startWorld();
  });
  afterEach(() => w.close());

  it("never holds or chases a disputed invoice; the undisputed one is proposed for hold", async () => {
    const due = Math.floor(NOW / 1000) - 90 * 86_400;
    w.state.stripe.invoices = [
      { id: "in_alice_old", customer: "cus_alice", status: "open", amount_due: 9800, amount_remaining: 9800, currency: "usd", due_date: due, metadata: {} },
      { id: "in_dev_old", customer: "cus_dev", status: "open", amount_due: 4900, amount_remaining: 4900, currency: "usd", due_date: due, metadata: { disputed: "true" } },
    ];
    const e = w.engine(collectionsCreditHold, { now: () => NOW });
    const { body } = await e.handle({ action: "start", runId: "ar-1", input: { arChannel: "C0FINANCE1" }, requestedBy: { userId: "U1" } });
    const holds = body.actions.filter((a: any) => a.kind === "stripe.credit_hold");
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ status: "pending_approval", summary: { customerId: "cus_alice" } });
    const drafts = body.actions.filter((a: any) => a.kind === "gmail.draft_reminder");
    expect(drafts.map((a: any) => a.summary.to)).toEqual(["alice@acmecorp.com"]);
    expect(w.state.slack.messages[0].text).toMatch(/disputed, no hold/);
  });
});
