import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCampaign, POLICY, userAccessReview } from "../src/workflows/user-access-review";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const DAY = 86_400_000;
const user = { userId: "U_GRC" };
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);

const input = (over: object = {}) => ({
  campaignId: "UAR-2026-Q4",
  scope: { workosOrganizations: ["org_acme"], githubOrg: "acme" },
  owners: { workos: { userId: "U_IT_OWNER", email: "it.owner@acme.example" }, github: { userId: "U_ENG_OWNER", email: "eng.owner@acme.example" } },
  githubEmails: { "eng-owner": "eng.owner@acme.example", dev1: "dev1@acme.example" },
  grcChannel: "C0SUPPORT1",
  approvers: ["U_CISO"],
  ...over,
});

describe("campaign", () => {
  it("refuses a partial pull and an oversized scope; flags self-review", () => {
    const parsed = userAccessReview.input.parse(input());
    const e = (o: object) => ({ id: "x", system: "github" as const, resource: "acme", role: "admin", holderEmail: "eng.owner@acme.example", holderRef: "eng-owner", privileged: true, dormant: false, ...o });
    expect(buildCampaign(parsed, [], ["github-entitlements"]).mode).toBe("blocked");
    expect(buildCampaign(parsed, Array.from({ length: POLICY.maxEntitlements + 1 }, (_, i) => e({ id: String(i) })), []).mode).toBe("too_large");
    expect(buildCampaign(parsed, [e({})], []).items[0]).toMatchObject({ selfReview: true, reviewer: { userId: "U_ENG_OWNER" } });
  });
});

describe("user-access-review runs", () => {
  let w: World;
  beforeEach(async () => {
    w = await startWorld();
    const W = w.state.workos;
    W.users.push({ id: "u_admin", email: "ops.admin@acme.example", last_sign_in_at: new Date(NOW - 2 * DAY).toISOString() }, { id: "u_old", email: "old.contractor@acme.example", last_sign_in_at: new Date(NOW - 200 * DAY).toISOString() });
    W.memberships.push({ id: "om_admin", user_id: "u_admin", organization_id: "org_acme", role: { slug: "admin" }, status: "active" }, { id: "om_old", user_id: "u_old", organization_id: "org_acme", role: { slug: "member" }, status: "active" });
    w.state.github.members.push({ org: "acme", login: "eng-owner", id: 1, role: "admin" }, { org: "acme", login: "dev1", id: 2, role: "member" });
  });
  afterEach(() => w.close());
  const signal = (e: any, id: string, userId: string, value: "approve" | "reject") => e.handle({ action: "signal", runId: "uar", actionId: id, value, userId });

  it("runs a campaign end to end: decisions, no self-review, reminders, deadline defaults, verified evidence", async () => {
    const clock = { t: NOW };
    const e = w.engine(userAccessReview, { now: () => clock.t });
    const r = await e.handle({ action: "start", runId: "uar", input: input(), requestedBy: user });
    expect(r.body).toMatchObject({ phase: "WAITING", output: { mode: "review", entitlements: 4, privileged: 2, dormant: 1, selfReview: 1 } });

    // The GitHub owner can't certify their own admin seat; the CISO can.
    expect((await signal(e, "revoke:github:acme:eng-owner", "U_ENG_OWNER", "reject")).status).toBe(403);
    await signal(e, "revoke:github:acme:eng-owner", "U_CISO", "reject");
    // The dormant contractor is revoked; the ops admin is kept.
    await signal(e, "revoke:workos:om_old", "U_IT_OWNER", "approve");
    await signal(e, "revoke:workos:om_admin", "U_IT_OWNER", "reject");
    expect(w.state.workos.memberships.map((m) => m.id)).toEqual(["om_admin"]);

    // Day 7: only the GitHub owner still owes a decision (dev1).
    clock.t = NOW + 7 * DAY + 1;
    await e.handle({ action: "tick" });
    expect(w.state.slack.messages.filter((m) => m.channel.startsWith("U_")).map((m) => [m.channel, m.text.match(/(\d+) access decision/)?.[1]])).toEqual([["U_ENG_OWNER", "1"]]);
    let s = (await e.handle({ action: "status", runId: "uar" })).body;
    expect(action(s, "slack.remind:U_IT_OWNER:d7")).toMatchObject({ status: "skipped", detail: { reason: "nothing left to review" } });

    // Deadline: dev1 (standard) is kept by default; the run closes with evidence.
    clock.t = NOW + POLICY.campaignDays * DAY + 1;
    await e.handle({ action: "tick" });
    s = (await e.handle({ action: "status", runId: "uar" })).body;
    expect(action(s, "revoke:github:acme:dev1")).toMatchObject({ status: "rejected", signal: { defaulted: true } });
    expect(action(s, "asana.evidence_record")).toMatchObject({ status: "applied", detail: { revoked: 1, kept: 3, failed: 0 } });
    expect(s.phase).toBe("DONE");
    expect(w.state.github.members.map((m) => m.login)).toEqual(["eng-owner", "dev1"]);
    const ev = (await e.handle({ action: "evidence", runId: "uar" })).body;
    expect(ev.verified).toBe(true);
    expect(ev.entries.map((x: any) => x.msg)).toEqual(expect.arrayContaining(["signal for revoke:github:acme:eng-owner by U_ENG_OWNER refused", "signal reject for revoke:github:acme:eng-owner by U_CISO"]));
  });

  it("unreviewed admin access is revoked at the deadline", async () => {
    const clock = { t: NOW };
    const e = w.engine(userAccessReview, { now: () => clock.t });
    await e.handle({ action: "start", runId: "uar", input: input({ scope: { workosOrganizations: ["org_acme"] } }), requestedBy: user });
    clock.t = NOW + POLICY.campaignDays * DAY + 1;
    await e.handle({ action: "tick" });
    expect(w.state.workos.memberships.map((m) => m.id)).toEqual(["om_old"]);
  });

  it("a system that can't be read blocks the whole campaign", async () => {
    w.faults.push({ method: "GET", path: /^\/orgs\/acme\/members$/, status: 502, body: {} });
    const r = await w.engine(userAccessReview, { now: () => NOW }).handle({ action: "start", runId: "uar", input: input(), requestedBy: user });
    expect(r.body).toMatchObject({ phase: "DONE", output: { mode: "blocked" } });
    expect(r.body.actions.filter((a: any) => a.kind === "access.decide_and_revoke")).toHaveLength(0);
  });

  it("access already removed by someone else is recorded, not an error", async () => {
    const e = w.engine(userAccessReview, { now: () => NOW });
    await e.handle({ action: "start", runId: "uar", input: input(), requestedBy: user });
    w.state.workos.memberships = w.state.workos.memberships.filter((m) => m.id !== "om_old");
    const r = await signal(e, "revoke:workos:om_old", "U_IT_OWNER", "approve");
    expect(action(r.body, "revoke:workos:om_old")).toMatchObject({ status: "applied", detail: { alreadyGone: true } });
  });
});
