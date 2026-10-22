import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Engine } from "../src/kit/engine";
import { FatalError } from "../src/kit/errors";
import { silentLogger } from "../src/kit/log";
import { MemoryStore } from "../src/kit/store";
import { templateDrafter } from "../src/kit/drafter";
import type { PlannedAction, WorkflowDef } from "../src/kit/types";

// A synthetic workflow that exercises every Kit v2 feature without providers.
const T0 = Date.parse("2026-11-02T09:00:00Z");
const HOUR = 3_600_000;
type In = { items: string[]; failAt?: string; deadlineDefault?: "approve" | "reject" | "fail" };
const effects: string[] = [];

function wf(opts: { scan?: (ctx: any) => Promise<unknown> } = {}): WorkflowDef<In> {
  return {
    id: "kit-v2-demo",
    title: "Kit v2 demo",
    org: "Test",
    team: "kit",
    description: "demo",
    audit: true,
    input: z.object({ items: z.array(z.string()).min(1), failAt: z.string().optional(), deadlineDefault: z.enum(["approve", "reject", "fail"]).optional() }),
    agents: [{ name: "scan", needs: [], run: async (ctx) => ({ summary: "ok", data: opts.scan ? await opts.scan(ctx) : null }) }],
    plan({ input, startedAt }) {
      const at = (h: number) => new Date(startedAt.getTime() + h * HOUR).toISOString();
      const actions: PlannedAction<In>[] = [];
      for (const item of input.items) {
        // Per-item decision from a reviewer who is not the requester; at the deadline the default applies.
        actions.push({
          id: `decide:${item}`, kind: "decide", provider: "stripe", agent: "plan", gate: "auto", summary: { item },
          awaitSignal: { from: ["U_REVIEWER", "U_REQUESTER"], notFrom: ["U_REQUESTER"], deadline: at(72), onDeadline: input.deadlineDefault ?? "reject" },
          async execute({ signal }) { effects.push(`revoke ${item} (${signal?.by})`); return { ref: `rev-${item}` }; },
        });
      }
      // A reminder 24 h in, only if something is still undecided.
      actions.push({
        id: "remind", kind: "remind", provider: "stripe", agent: "plan", gate: "auto", summary: {}, waitUntil: at(24),
        async execute({ statuses }) { const open = Object.entries(statuses).filter(([id, s]) => id.startsWith("decide:") && s === "awaiting_signal").length; effects.push(`remind ${open}`); return { ref: `remind-${open}` }; },
      });
      return actions;
    },
    output: () => ({}),
    catalog: [],
  };
}

function saga(): WorkflowDef<In> {
  return {
    id: "saga-demo", title: "saga", org: "Test", team: "kit", description: "saga", audit: true,
    input: z.object({ items: z.array(z.string()).min(1), failAt: z.string().optional() }),
    agents: [],
    plan({ input }) {
      return input.items.map((item): PlannedAction<In> => ({
        id: `step:${item}`, kind: "step", provider: "stripe", agent: "plan", gate: "auto", summary: { item },
        onFailure: "compensate",
        async execute() { if (item === input.failAt) throw new FatalError(`${item} refused`); effects.push(`do ${item}`); return { ref: item }; },
        ...(item !== "no-undo" ? { async compensate(_ctx: unknown, r: { ref: string }) { effects.push(`undo ${r.ref}`); return { ref: `undo-${r.ref}` }; } } : {}),
      }));
    },
    output: () => ({}),
    catalog: [],
  };
}

const engine = (def: WorkflowDef<In>, clock: { t: number }, store = new MemoryStore()) =>
  new Engine(def, { store, providers: () => ({ stripe: {} as any }), drafter: templateDrafter, log: silentLogger, now: () => clock.t });
const user = { userId: "U_REQUESTER" };
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);

describe("Kit v2: signals and timers", () => {
  it("waits for per-item signals, enforces who may send them, and fires a reminder only for what's still open", async () => {
    effects.length = 0;
    const clock = { t: T0 };
    const e = engine(wf(), clock);
    const r = await e.handle({ action: "start", runId: "uar", input: { items: ["a", "b"] }, requestedBy: user });
    expect(r.body).toMatchObject({ phase: "WAITING", wakeAt: new Date(T0 + 24 * HOUR).toISOString(), counts: { awaitingSignal: 2, scheduled: 1 } });

    expect((await e.handle({ action: "signal", runId: "uar", actionId: "decide:a", value: "approve", userId: "U_REQUESTER" })).status).toBe(403);
    expect((await e.handle({ action: "signal", runId: "uar", actionId: "decide:a", value: "approve", userId: "U_STRANGER" })).status).toBe(403);
    const s = await e.handle({ action: "signal", runId: "uar", actionId: "decide:a", value: "approve", userId: "U_REVIEWER" });
    expect(action(s.body, "decide:a")).toMatchObject({ status: "applied", signal: { value: "approve", by: "U_REVIEWER" } });
    expect((await e.handle({ action: "signal", runId: "uar", actionId: "decide:a", value: "reject", userId: "U_REVIEWER" })).status).toBe(409);
    expect((await e.handle({ action: "signal", runId: "uar", actionId: "nope", value: "approve", userId: "U_REVIEWER" })).status).toBe(404);

    // Nothing is due yet; a tick wakes nobody.
    expect((await e.handle({ action: "tick" })).body.woken).toEqual([]);
    clock.t = T0 + 25 * HOUR;
    expect((await e.handle({ action: "tick" })).body.woken).toEqual(["uar"]);
    expect(effects).toEqual(["revoke a (U_REVIEWER)", "remind 1"]);

    // At the deadline the unreviewed item takes its default (reject) and the run finishes.
    clock.t = T0 + 73 * HOUR;
    await e.handle({ action: "tick" });
    const done = (await e.handle({ action: "status", runId: "uar" })).body;
    expect(done).toMatchObject({ phase: "DONE", outcome: "ok" });
    expect(action(done, "decide:b")).toMatchObject({ status: "rejected", signal: { by: "deadline", defaulted: true } });
  });

  it("a deadline that defaults to approve executes; one that defaults to fail fails the item", async () => {
    effects.length = 0;
    const clock = { t: T0 };
    const e = engine(wf(), clock);
    await e.handle({ action: "start", runId: "x", input: { items: ["a"], deadlineDefault: "approve" }, requestedBy: user });
    await e.handle({ action: "start", runId: "y", input: { items: ["a"], deadlineDefault: "fail" }, requestedBy: user });
    clock.t = T0 + 80 * HOUR;
    expect((await e.handle({ action: "tick" })).body.woken.sort()).toEqual(["x", "y"]);
    expect(action((await e.handle({ action: "status", runId: "x" })).body, "decide:a")).toMatchObject({ status: "applied", signal: { by: "deadline", defaulted: true } });
    expect(action((await e.handle({ action: "status", runId: "y" })).body, "decide:a")).toMatchObject({ status: "failed", errorCode: "signal_deadline" });
  });

  it("a waiting run survives a restart (new engine, same store) and a cancel skips what was waiting", async () => {
    const clock = { t: T0 };
    const store = new MemoryStore();
    await engine(wf(), clock, store).handle({ action: "start", runId: "r", input: { items: ["a"] }, requestedBy: user });
    const after = engine(wf(), clock, store);
    await after.handle({ action: "signal", runId: "r", actionId: "decide:a", value: "approve", userId: "U_REVIEWER" });
    expect(action((await after.handle({ action: "status", runId: "r" })).body, "decide:a").status).toBe("applied");
    const c = await after.handle({ action: "cancel", runId: "r", userId: "U_ADMIN" });
    expect(c.body).toMatchObject({ phase: "CANCELLED", result: "cancelled" });
    expect(action(c.body, "remind").status).toBe("skipped");
  });
});

describe("Kit v2: compensation", () => {
  it("undoes applied steps in reverse order when a required step fails, and skips the rest", async () => {
    effects.length = 0;
    const e = engine(saga(), { t: T0 });
    const r = await e.handle({ action: "start", runId: "s", input: { items: ["one", "no-undo", "two", "boom", "three"], failAt: "boom" }, requestedBy: user });
    expect(effects).toEqual(["do one", "do no-undo", "do two", "undo two", "undo one"]);
    expect(r.body).toMatchObject({ phase: "DONE", outcome: "compensated", counts: { compensated: 2, failed: 1, skipped: 1 } });
    expect(action(r.body, "step:no-undo")).toMatchObject({ status: "applied", compensation: { status: "not_supported" } });
  });
});

describe("Kit v2: checkpoints", () => {
  it("a long agent resumes from its last checkpoint when another container takes over a stale run", async () => {
    const store = new MemoryStore();
    const seen: number[] = [];
    let first = true;
    const scan = async (ctx: any) => {
      let page = (await ctx.checkpoint.load("page")) ?? 0;
      for (; page < 5; page++) {
        // The first container dies at page 3: its agent never returns.
        if (first && page === 3) { first = false; await new Promise(() => {}); }
        seen.push(page);
        await ctx.checkpoint.save("page", page + 1);
      }
      return { pages: page };
    };
    const clock = { t: T0 };
    void engine(wf({ scan }), clock, store).handle({ action: "start", runId: "c", input: { items: ["a"] }, requestedBy: user, wait: false });
    await new Promise((r) => setTimeout(r, 50));
    clock.t = T0 + 5 * 60_000; // the run is now stale
    const r = await engine(wf({ scan }), clock, store).handle({ action: "resume", runId: "c" });
    expect(r.body.result).toBe("resumed");
    expect(seen).toEqual([0, 1, 2, 3, 4]);
    expect(r.body.agents[0]).toMatchObject({ status: "ok", summary: "ok" });
  });
});

describe("Kit v2: audit evidence", () => {
  it("every event is hash-chained; tampering with a stored entry is detected", async () => {
    const store = new MemoryStore();
    const e = engine(saga(), { t: T0 }, store);
    await e.handle({ action: "start", runId: "a", input: { items: ["one", "two"] }, requestedBy: user });
    const ev = (await e.handle({ action: "evidence", runId: "a" })).body;
    expect(ev.verified).toBe(true);
    expect(ev.entries.map((x: any) => x.msg)).toContain("step:one: applied");
    expect(ev.entries.at(-1).hash).toBe(ev.head);
    const item = (await store.list("audit#a#")).find((x: any) => x.msg === "step:one: applied")!;
    await store.replace({ ...item, msg: "step:one: skipped" });
    expect((await e.handle({ action: "evidence", runId: "a" })).body).toMatchObject({ verified: false, brokenAt: item.seq });
  });
});
