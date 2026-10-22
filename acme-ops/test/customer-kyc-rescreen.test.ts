import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { customerKycRescreen, hitsKey, isCleared } from "../src/workflows/customer-kyc-rescreen";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const DAY = 86_400_000;
const user = { userId: "U_SCHEDULER" };
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);
const input = (over: object = {}) => ({ rescreenId: "KYC-2026-10-14", program: "marketplace-us", complianceChannel: "C0CSOPS001", analysts: ["U_ANALYST", "U_ANALYST_2"], mlro: ["U_MLRO", "U_ANALYST"], ...over });
const acct = (id: string, name: string, extra: object = {}) => ({ id, country: "US", business_profile: { name }, settings: { payouts: { schedule: { interval: "daily" } } }, metadata: { acme_program: "marketplace-us" }, ...extra });
const sig = (id: string, userId: string, value: "approve" | "reject") => ({ action: "signal" as const, runId: "k", actionId: id, value, userId });

describe("clearance", () => {
  it("covers exactly the hit set the analyst saw, until it expires", () => {
    const k = hitsKey([{ name: "A", source: "SDN", score: 90 }]);
    expect(isCleared(`${k}@${new Date(NOW + DAY).toISOString()}`, k, NOW)).toBe(true);
    expect(isCleared(`${k}@${new Date(NOW - DAY).toISOString()}`, k, NOW)).toBe(false);
    expect(isCleared(`${k}@${new Date(NOW + DAY).toISOString()}`, hitsKey([{ name: "B", source: "SDN", score: 90 }]), NOW)).toBe(false);
  });
});

describe("customer-kyc-rescreen runs", () => {
  let w: World;
  beforeEach(async () => {
    w = await startWorld();
    w.state.stripe.accounts.push(acct("acct_clean", "Harbor Supplies"), acct("acct_strong", "Volga Trading"), acct("acct_weak", "Nordic Volga Foods"), acct("acct_other", "Volga Trading", { metadata: { acme_program: "other" } }));
    w.state.screening.entries.push({ name: "Volga Trading", source: "SDN", score: 100 }, { name: "Nordic Volga Foods", source: "EL", score: 88 });
  });
  afterEach(() => w.close());

  it("a strong match is held at once; a false positive is cleared and the hold released", async () => {
    const e = w.engine(customerKycRescreen, { now: () => NOW });
    const r = await e.handle({ action: "start", runId: "k", input: input(), requestedBy: user });
    expect(r.body.output).toEqual({ mode: "rescreen", accounts: 3, matches: 2, held: 1, previouslyCleared: 0 });
    expect(w.state.stripe.accounts[1].settings.payouts.schedule.interval).toBe("manual");
    expect(w.state.stripe.accounts[2].settings.payouts.schedule.interval).toBe("daily");
    const d = await e.handle(sig("compliance.review:acct_strong", "U_ANALYST", "reject"));
    expect(action(d.body, "stripe.clear:acct_strong")).toMatchObject({ status: "applied", detail: { released: true } });
    expect(w.state.stripe.accounts[1].settings.payouts.schedule.interval).toBe("daily");
    expect(action(d.body, "mlro.sar_decision:acct_strong").status).toBe("skipped");
  });

  it("a cleared hit set isn't raised again by the next sweep", async () => {
    const e = w.engine(customerKycRescreen, { now: () => NOW });
    await e.handle({ action: "start", runId: "k", input: input(), requestedBy: user });
    await e.handle(sig("compliance.review:acct_weak", "U_ANALYST", "reject"));
    const r = await e.handle({ action: "start", runId: "k2", input: input({ rescreenId: "KYC-2026-10-21" }), requestedBy: user });
    expect(r.body.output).toMatchObject({ matches: 1, previouslyCleared: 1 });
  });

  it("a true match stays held and goes to an MLRO who isn't the analyst", async () => {
    const e = w.engine(customerKycRescreen, { now: () => NOW });
    await e.handle({ action: "start", runId: "k", input: input(), requestedBy: user });
    const d = await e.handle(sig("compliance.review:acct_weak", "U_ANALYST", "approve"));
    expect(w.state.stripe.accounts[2]).toMatchObject({ settings: { payouts: { schedule: { interval: "manual" } } }, metadata: { acme_kyc_status: "true_match" } });
    expect(action(d.body, "stripe.clear:acct_weak")).toMatchObject({ status: "skipped" });
    expect((await e.handle({ action: "signal", runId: "k", actionId: "mlro.sar_decision:acct_weak", value: "approve", userId: "U_ANALYST" })).status).toBe(403);
    await e.handle({ action: "signal", runId: "k", actionId: "mlro.sar_decision:acct_weak", value: "approve", userId: "U_MLRO" });
    expect(w.state.slack.messages.at(-1).text).toMatch(/MLRO U_MLRO decided to file a SAR/);
  });

  it("undecided matches are reminded; a SAR decision missing at 30 days fails loudly", async () => {
    const clock = { t: NOW };
    const e = w.engine(customerKycRescreen, { now: () => clock.t });
    await e.handle({ action: "start", runId: "k", input: input(), requestedBy: user });
    clock.t = NOW + 3 * DAY + 1;
    await e.handle({ action: "tick" });
    expect(w.state.slack.messages.filter((m: any) => /undecided sanctions match for 3 days; payouts are on hold/.test(m.text))).toHaveLength(1);
    await e.handle(sig("compliance.review:acct_strong", "U_ANALYST", "approve"));
    clock.t = NOW + 30 * DAY + 1;
    await e.handle({ action: "tick" });
    const s = (await e.handle({ action: "status", runId: "k" })).body;
    expect(action(s, "mlro.sar_decision:acct_strong").status).toBe("failed");
  });

  it("when screening can't run, nothing is screened and compliance is told", async () => {
    w.faults.push({ method: "GET", path: /^\/consolidated_screening_list/, status: 503, body: {} });
    const r = await w.engine(customerKycRescreen, { now: () => NOW }).handle({ action: "start", runId: "k", input: input(), requestedBy: user });
    expect(r.body.output).toEqual({ mode: "blocked" });
    expect(w.state.slack.messages[0].text).toMatch(/could not be screened/);
  });
});
