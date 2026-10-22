import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { customerDataSweep, decide, findIssues, POLICY } from "../src/workflows/customer-data-sweep";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const user = { userId: "U_REVOPS" };
const kind = (body: any, k: string) => body.actions.filter((a: any) => a.kind === k);

describe("issues and decision", () => {
  const c = (id: string, email: string | null, country: string | null, flag: string | null = null) => ({ id, email, country, flag });
  it("flags missing countries and duplicate emails, skipping ones already flagged the same way", () => {
    expect(findIssues([c("a", "x@e.com", null), c("b", "d@e.com", "US"), c("c", "D@e.com", "DE"), c("d", "y@e.com", null, "missing_country")])).toEqual([
      { customer: "a", issue: "missing_country" },
      { customer: "b", issue: "duplicate_email" },
      { customer: "c", issue: "duplicate_email" },
    ]);
  });
  it("refuses an incomplete scan instead of flagging part of it", () => {
    const input = customerDataSweep.input.parse({ segment: "eu", expectedMin: 3, revopsChannel: "C0CSOPS001" });
    const scan = { pages: 1, scanned: 2, cursorStalled: false, hitCap: false, segment: [c("a", "a@e.com", null), c("b", "b@e.com", "US")] };
    expect(decide(input, scan)).toMatchObject({ mode: "blocked", reason: "found 2 of at least 3 customers in eu; the scan is incomplete" });
    expect(decide(input, { ...scan, cursorStalled: true }).reason).toBe("pagination did not advance after page 1; the scan is incomplete");
    expect(decide({ ...input, expectedMin: 2, autoFlagMax: 0 }, scan).flags).toEqual([{ customer: "a", issue: "missing_country", gate: "approval" }]);
  });
});

describe("customer-data-sweep runs", () => {
  let w: World;
  const N = 250;
  beforeEach(async () => {
    w = await startWorld();
    for (let i = 0; i < N; i++) w.state.stripe.customers.push({ id: `cus_s${String(i).padStart(4, "0")}`, email: `c${i}@scale.example.com`, address: i % 10 === 0 ? null : { country: "US" }, metadata: { acme_segment: "scale" } });
  });
  afterEach(() => w.close());
  const sweep = (e: any, over: object = {}, runId = "sw") => e.handle({ action: "start", runId, input: { segment: "scale", expectedMin: N, revopsChannel: "C0CSOPS001", approvers: ["U_REVOPS_LEAD"], ...over }, requestedBy: user });

  it("pages through every customer and flags the 25 without a country", async () => {
    const r = await sweep(w.engine(customerDataSweep, { now: () => NOW }));
    expect(r.body).toMatchObject({ phase: "DONE", output: { mode: "flag", segmentCount: N, flags: 25, flagsAuto: 25 } });
    expect(w.requests.filter((x) => x.path === "/v1/customers").length).toBe(Math.ceil((N + 2) / POLICY.pageSize));
    expect(w.state.stripe.customers.filter((c) => c.metadata?.acme_dq === "missing_country")).toHaveLength(25);
    const again = await sweep(w.engine(customerDataSweep, { now: () => NOW }), {}, "sw-2");
    expect(again.body.output).toMatchObject({ mode: "nothing" });
  });

  it("a backend that ignores the cursor is caught; nothing is flagged", async () => {
    w.state.stripe.ignoreCursor = true;
    const r = await sweep(w.engine(customerDataSweep, { now: () => NOW }));
    expect(r.body.output).toMatchObject({ mode: "blocked", reason: "pagination did not advance after page 2; the scan is incomplete" });
    expect(kind(r.body, "stripe.flag_customer")).toHaveLength(0);
    expect(w.state.slack.messages[0].text).toContain(":rotating_light:");
  });

  it("a scan that finds fewer customers than expected flags nothing", async () => {
    const r = await sweep(w.engine(customerDataSweep, { now: () => NOW }), { expectedMin: N + 1 });
    expect(r.body.output.mode).toBe("blocked");
    expect(kind(r.body, "stripe.flag_customer")).toHaveLength(0);
  });

  it("past the per-run limit, flags wait for approval", async () => {
    const e = w.engine(customerDataSweep, { now: () => NOW });
    const r = await sweep(e, { autoFlagMax: 10 });
    expect(r.body).toMatchObject({ phase: "AWAITING_APPROVAL", output: { flags: 25, flagsAuto: 10 } });
    expect(w.state.stripe.customers.filter((c) => c.metadata?.acme_dq)).toHaveLength(10);
    await e.handle({ action: "decide", runId: "sw", decision: "approve", userId: "U_REVOPS_LEAD" });
    expect(w.state.stripe.customers.filter((c) => c.metadata?.acme_dq)).toHaveLength(25);
  });

  it("a rate-limited list fails the scan closed", async () => {
    w.faults.push({ method: "GET", path: /^\/v1\/customers$/, status: 429, body: { error: { code: "rate_limit" } } });
    const r = await sweep(w.engine(customerDataSweep, { now: () => NOW }));
    expect(r.body.output).toMatchObject({ mode: "blocked", reason: "customers could not be listed" });
  });
});
