import { describe, expect, it } from "vitest";
import { sleep } from "../src/lib/retry";
import { fakeWorld, type FakeWorld } from "../src/local/fake-deps";
import { ScriptedLlm, defaultScript } from "../src/local/scripted-llm";
import { Engine, type EngineOptions } from "../src/workflow/engine";

const REQUEST = "Dana (dana@acme.test) wants 20 pro seats and the onboarding package, 10% off. Check billing and send a survey.";
const FAST: EngineOptions = { stepBackoffMs: 5 };

type View = { phase: string; outcome?: string; duplicate?: boolean; agents: { agent: string; status: string }[]; events: { key: string }[] };

function setup(opts: EngineOptions = {}, world = fakeWorld()) {
  const engine = new Engine(world.deps, { ...FAST, ...opts });
  const start = (runId: string, text = REQUEST, wait = true) =>
    engine.handle({ action: "start", runId, requestText: text, requestedBy: { userId: "U1" }, slack: { channel: "C1", threadTs: "1.1" }, wait }) as Promise<View>;
  const decide = (runId: string, decision: "approve" | "reject", userId = "U-approver") =>
    engine.handle({ action: "decide", runId, decision, userId, wait: true }) as Promise<View>;
  const status = (runId: string) => engine.handle({ action: "status", runId }) as Promise<View>;
  return { world, engine, start, decide, status };
}

const quoteEmails = (w: FakeWorld) => w.mail.sent.filter((m) => m.subject.includes("quote"));
const surveys = (w: FakeWorld) => w.mail.sent.filter((m) => m.subject.includes("doing"));

describe("run lifecycle", () => {
  it("start parks at approval; approve dispatches exactly once", async () => {
    const { world, start, decide } = setup();
    expect((await start("r1")).phase).toBe("AWAITING_APPROVAL");
    expect(world.mail.sent).toHaveLength(0); // nothing customer-facing before approval
    const done = await decide("r1", "approve");
    expect(done.phase).toBe("DONE");
    expect([...world.billing.quotes.values()].map((q) => q.status)).toEqual(["open"]);
    expect(quoteEmails(world)).toHaveLength(1);
    expect(surveys(world)).toHaveLength(1);
    expect(world.crm.tasks).toHaveLength(1);
    expect(done.events.map((e) => e.key)).toEqual(["intake", "approval", "done"]);
  });

  it("reject sends nothing to the customer", async () => {
    const { world, start, decide } = setup();
    await start("r2");
    expect((await decide("r2", "reject")).outcome).toBe("recorded");
    expect(world.mail.sent).toHaveLength(0);
    expect([...world.billing.quotes.values()].map((q) => q.status)).toEqual(["draft"]);
  });

  it("stops early with a clear error when the request has no customer email", async () => {
    const { start, status } = setup();
    await start("r3", "quote 5 pro seats for Acme please");
    const s = (await status("r3")) as View & { error: string };
    expect(s.phase).toBe("FAILED");
    expect(s.error).toContain("No customer email");
  });
});

describe("duplicates and races", () => {
  it("five concurrent starts with the same runId make one run", async () => {
    const llm = new ScriptedLlm();
    const { start } = setup({}, fakeWorld({ llm }));
    const results = await Promise.all(Array.from({ length: 5 }, () => start("dup")));
    expect(results.filter((r) => r.duplicate)).toHaveLength(4);
    expect(llm.calls.filter((c) => c === "intake")).toHaveLength(1);
  });

  it("simultaneous approve/reject clicks from two people record exactly one decision", async () => {
    const { world, start, decide } = setup();
    await start("race");
    const outcomes = await Promise.all([decide("race", "approve", "U-alice"), decide("race", "reject", "U-bob"), decide("race", "approve", "U-alice")]);
    expect(outcomes.filter((o) => o.outcome === "recorded")).toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome === "already_decided")).toHaveLength(2);
    expect(quoteEmails(world).length).toBeLessThanOrEqual(1);
  });

  it("only listed approvers can decide", async () => {
    const { start, decide } = setup({}, fakeWorld({ approverUserIds: ["U-boss"] }));
    await start("auth");
    expect((await decide("auth", "approve", "U-intern")).outcome).toBe("forbidden");
    expect((await decide("auth", "approve", "U-boss")).outcome).toBe("recorded");
  });

  it("two concurrent runs for the same new customer don't duplicate the customer or the survey", async () => {
    const { world, start, decide } = setup();
    await Promise.all([start("A"), start("B")]);
    await Promise.all([decide("A", "approve"), decide("B", "approve")]);
    expect(world.crm.contacts.size).toBe(1);
    expect(world.billing.customers.size).toBe(1);
    expect(world.billing.quotes.size).toBe(2); // two requests → two quotes, by design
    expect(surveys(world)).toHaveLength(1); // cooldown reservation
  });
});

describe("failures", () => {
  it("isolates a failing agent: billing exhausts retries, the run still completes", async () => {
    const { world, start, decide } = setup();
    world.faults.inject("snapshot", 100);
    world.billing.customers.set("cus_existing", { id: "cus_existing", email: "dana@acme.test" });
    const parked = await start("iso");
    expect(parked.agents.find((a) => a.agent === "billing")?.status).toBe("failed");
    expect(parked.agents.filter((a) => a.status === "ok").map((a) => a.agent).sort()).toEqual(["quote", "research", "survey"]);
    expect((await decide("iso", "approve")).phase).toBe("DONE");
    expect(world.crm.notes[0]?.body).toContain("billing: failed");
  });

  it("retries transient provider faults without duplicating any side effect", async () => {
    const { world, start, decide } = setup();
    world.faults.inject("createDraftQuote", 2);
    world.faults.inject("sendOnce", 1);
    world.faults.inject("createTask", 2);
    await start("flaky");
    expect((await decide("flaky", "approve")).phase).toBe("DONE");
    expect(world.billing.quotes.size).toBe(1);
    expect(world.mail.sent).toHaveLength(2);
    expect(world.crm.tasks).toHaveLength(1);
  });

  it("parks a run that stays transiently broken, and resume finishes it later", async () => {
    const { world, engine, start, decide } = setup({ stepAttempts: 2 });
    world.faults.inject("createNote", 4); // handoff can't write its CRM note for a while
    const parked = (await start("stall")) as View & { lastError: string };
    expect(parked.phase).toBe("AGENTS_DONE");
    expect(parked.lastError).toContain("createNote");
    await engine.handle({ action: "resume", runId: "stall", wait: true });
    await engine.handle({ action: "resume", runId: "stall", wait: true });
    expect((await decide("stall", "approve")).phase).toBe("DONE");
    expect(world.crm.notes).toHaveLength(1);
  });
});

describe("approval window", () => {
  it("a click after the window says expired and nothing is sent", async () => {
    const { world, start, decide, status } = setup({ approvalTtlMs: 30 });
    await start("late");
    await sleep(50);
    expect((await decide("late", "approve")).outcome).toBe("expired");
    expect((await status("late")).phase).toBe("EXPIRED");
    expect(world.mail.sent).toHaveLength(0);
  });

  it("sweep expires overdue approvals", async () => {
    const { engine, start, status } = setup({ approvalTtlMs: 30 });
    await start("sw1");
    await start("sw2");
    await sleep(50);
    expect(await engine.handle({ action: "sweep" })).toMatchObject({ expired: 2 });
    expect((await status("sw1")).phase).toBe("EXPIRED");
  });

  it("cancel while waiting for approval closes the run", async () => {
    const { engine, start, decide } = setup();
    await start("cx");
    expect(await engine.handle({ action: "cancel", runId: "cx", userId: "U1" })).toMatchObject({ outcome: "cancelled" });
    expect((await decide("cx", "approve")).outcome).toBe("closed");
  });
});

describe("crash recovery (AgentCore session ends mid-run)", () => {
  it("a new container resumes from the last checkpoint, and the stalled one can't overwrite it", async () => {
    const world = fakeWorld();
    // Container A hangs in handoff and stops heart-beating (it "died").
    let release!: () => void;
    const hung = new Promise<void>((r) => (release = r));
    const llmA = new ScriptedLlm({ ...defaultScript, handoff: async (p) => (await hung, defaultScript.handoff!(p)) });
    const a = new Engine({ ...world.deps, llm: llmA }, { ...FAST, leaseMs: 40, heartbeatMs: 60_000 });
    await a.handle({ action: "start", runId: "crash", requestText: REQUEST, requestedBy: { userId: "U1" } });
    while (!llmA.calls.includes("handoff")) await sleep(5);

    // Container B picks it up after the lease lapses. It must not redo intake or the agents.
    await sleep(60);
    const llmB = new ScriptedLlm();
    const b = new Engine({ ...world.deps, llm: llmB }, FAST);
    const resumed = (await b.handle({ action: "resume", runId: "crash", wait: true })) as View;
    expect(resumed.phase).toBe("AWAITING_APPROVAL");
    expect(llmB.calls).toEqual(["handoff"]);

    // B finishes the run before A wakes up.
    expect(((await b.handle({ action: "decide", runId: "crash", decision: "approve", userId: "U-approver", wait: true })) as View).phase).toBe("DONE");

    // A wakes up with stale state: its checkpoint is fenced off, so it can't rewind DONE.
    release();
    await a.idle();
    const s = (await b.handle({ action: "status", runId: "crash" })) as View;
    expect(s.phase).toBe("DONE");
    expect(world.crm.contacts.size).toBe(1);
    expect(world.billing.quotes.size).toBe(1);
    expect(world.mail.sent).toHaveLength(2);
  });
});
