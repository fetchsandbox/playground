import { describe, expect, it } from "vitest";
import { fakeWorld, type FakeWorld } from "../src/local/fake-deps";
import { LocalTaskBroker, runWorkflowLocally } from "../src/local/orchestrator";
import { decideApproval } from "../src/workflow/approval";
import type { AgentResult, WorkflowInput } from "../src/types";

const REQUEST = "Dana (dana@acme.test) wants 20 pro seats and the onboarding package, 10% off. Check billing and send a survey.";

function input(runId: string, text = REQUEST): WorkflowInput {
  return { runId, requestText: text, requestedBy: { userId: "U1" }, slack: { channel: "C1", threadTs: "1.1" }, receivedAt: "2026-10-16T00:00:00Z" };
}

function run(world: FakeWorld, runId: string, opts: { decision?: "approve" | "reject" | "none"; text?: string } = {}) {
  const broker = new LocalTaskBroker();
  return runWorkflowLocally(input(runId, opts.text), world.deps, {
    broker,
    approvalTimeoutMs: opts.decision === "none" ? 50 : 5_000,
    onApprovalRequested: (id) => {
      if (opts.decision !== "none") void decideApproval(id, opts.decision ?? "approve", "U-approver", world.deps, broker);
    },
  });
}

const agents = (state: unknown) => (state as { agents: AgentResult[] }).agents;

describe("end-to-end workflow (fake providers, scripted LLM)", () => {
  it("happy path: quote finalized, one email, one survey, one owner task", async () => {
    const w = fakeWorld();
    const res = await run(w, "run-happy");
    expect(res.terminal).toBe("done");
    expect([...w.billing.quotes.values()].map((q) => q.status)).toEqual(["open"]);
    expect(w.mail.sent.map((m) => m.subject)).toHaveLength(2);
    expect(w.crm.tasks).toHaveLength(1);
    expect(w.crm.deals.size).toBe(1);
  });

  it("rejection sends nothing to the customer", async () => {
    const w = fakeWorld();
    const res = await run(w, "run-reject", { decision: "reject" });
    expect(res.terminal).toBe("rejected");
    expect(w.mail.sent).toHaveLength(0);
    expect([...w.billing.quotes.values()].map((q) => q.status)).toEqual(["draft"]);
  });

  it("approval timeout ends safely and a late click is told it expired", async () => {
    const w = fakeWorld();
    const broker = new LocalTaskBroker();
    const res = await run(w, "run-timeout", { decision: "none" });
    expect(res.terminal).toBe("expired");
    await expect(decideApproval("run-timeout", "approve", "U-late", w.deps, broker)).resolves.toEqual({ outcome: "expired" });
    expect(w.mail.sent).toHaveLength(0);
  });

  it("isolates a failing agent: billing exhausts retries, everything else still completes", async () => {
    const w = fakeWorld();
    w.faults.inject("snapshot", 100);
    w.billing.customers.set("cus_existing", { id: "cus_existing", email: "dana@acme.test" });
    const res = await run(w, "run-billing-down");
    expect(res.terminal).toBe("done");
    const billing = agents(res.state).find((a) => a.agent === "billing");
    expect(billing?.status).toBe("failed");
    expect(agents(res.state).filter((a) => a.status === "ok").map((a) => a.agent).sort()).toEqual(["quote", "research", "survey"]);
    expect(w.crm.notes[0]?.body).toContain("billing: failed");
  });

  it("retries transient provider faults without duplicating any side effect", async () => {
    const w = fakeWorld();
    w.faults.inject("createDraftQuote", 2);
    w.faults.inject("sendOnce", 1); // first customer email fails → dispatch is retried as a whole
    w.faults.inject("createTask", 2);
    const res = await run(w, "run-flaky");
    expect(res.terminal).toBe("done");
    expect(w.billing.quotes.size).toBe(1);
    expect(w.mail.sent).toHaveLength(2); // quote email + survey, each exactly once
    expect(w.crm.tasks).toHaveLength(1);
  });

  it("two concurrent runs for the same brand-new customer don't duplicate the customer or the survey", async () => {
    const w = fakeWorld();
    const [a, b] = await Promise.all([run(w, "run-A"), run(w, "run-B")]);
    expect([a.terminal, b.terminal]).toEqual(["done", "done"]);
    expect(w.crm.contacts.size).toBe(1); // HubSpot unique-email + 409 adoption
    expect(w.billing.customers.size).toBe(1); // lease + strongly consistent lookup + idempotency key
    expect(w.billing.quotes.size).toBe(2); // two requests → two quotes, by design
    expect(w.mail.sent.filter((m) => m.subject.includes("doing"))).toHaveLength(1); // survey cooldown reservation
  });

  it("stops early with a clear message when the request has no customer email", async () => {
    const w = fakeWorld();
    const res = await run(w, "run-no-email", { text: "quote 5 pro seats for Acme please" });
    expect(res.terminal).toBe("failed");
    expect(w.chat.messages.at(-1)?.text).toContain("No customer email");
  });
});
