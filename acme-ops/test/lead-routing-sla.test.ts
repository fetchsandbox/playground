import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leadRoutingSla, route, type Lead } from "../src/workflows/lead-routing-sla";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const MIN = 60_000;
const user = { userId: "U_FORMS" };
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);
const pod = (ids: string[], mgr: string) => ({ reps: ids.map((id) => ({ ownerId: id, slackId: `U_REP_${id}` })), managerSlackId: mgr });
const input = (over: object = {}) => ({
  contactId: "500",
  pods: {
    NA: { enterprise: pod(["11", "12"], "U_MGR_NA_ENT"), commercial: pod(["21", "22", "23"], "U_MGR_NA_COM") },
    EMEA: { enterprise: pod(["31"], "U_MGR_EMEA_ENT"), commercial: pod(["41", "42"], "U_MGR_EMEA_COM") },
    APAC: { enterprise: pod(["51"], "U_MGR_APAC"), commercial: pod(["61"], "U_MGR_APAC") },
  },
  regions: { DE: "EMEA", FR: "EMEA", JP: "APAC" },
  salesChannel: "C0CSOPS001",
  ...over,
});

describe("routing", () => {
  const parsed = leadRoutingSla.input.parse(input());
  const lead = (o: Partial<Lead> = {}): Lead => ({ id: "500", email: "kim@northwind.example", domain: "northwind.example", country: "DE", employees: 300, ownerId: null, ...o });
  it("territory pod by region and segment, least loaded first, ties by plan order", () => {
    expect(route(parsed, lead(), null, { "41": 3, "42": 1 })).toMatchObject({ region: "EMEA", segment: "commercial", ownerId: "42", backupOwnerId: "41", how: "least_loaded", slaMinutes: 240 });
    expect(route(parsed, lead({ country: "US", employees: 5_000 }), null, {})).toMatchObject({ region: "NA", segment: "enterprise", ownerId: "11", slaMinutes: 60 });
  });
  it("an existing account's owner wins; an owned lead isn't re-routed", () => {
    expect(route(parsed, lead(), "41", { "41": 9, "42": 0 })).toMatchObject({ ownerId: "41", how: "account_owner", backupOwnerId: "42" });
    expect(route(parsed, lead({ ownerId: "99" }), null, {}).mode).toBe("already_owned");
  });
});

describe("lead-routing-sla runs", () => {
  let w: World;
  const contact = (id: string, p: Record<string, string>) => ({ id, properties: p, archived: false });
  beforeEach(async () => {
    w = await startWorld();
    w.state.hubspot.contacts.push(
      contact("500", { email: "kim@northwind.example", hs_email_domain: "northwind.example", country: "DE", numberofemployees: "300" }),
      contact("501", { email: "a@other.example", hubspot_owner_id: "41", hs_lead_status: "NEW" }),
      contact("502", { email: "b@other.example", hubspot_owner_id: "41", hs_lead_status: "NEW" }),
    );
  });
  afterEach(() => w.close());

  it("assigns the least-loaded rep, DMs them, and reassigns after a missed SLA; a second miss escalates", async () => {
    const clock = { t: NOW };
    const e = w.engine(leadRoutingSla, { now: () => clock.t });
    const r = await e.handle({ action: "start", runId: "lead", input: input(), requestedBy: user });
    expect(r.body).toMatchObject({ phase: "WAITING", output: { owner: "42", how: "least_loaded" } });
    expect(w.state.hubspot.contacts[0].properties).toMatchObject({ hubspot_owner_id: "42", hs_lead_status: "NEW" });
    expect(w.state.slack.messages[0]).toMatchObject({ channel: "U_REP_42", text: expect.stringContaining("within 240 min") });

    clock.t = NOW + 241 * MIN;
    await e.handle({ action: "tick" });
    expect(w.state.hubspot.contacts[0].properties.hubspot_owner_id).toBe("41");
    expect(w.state.slack.messages.map((m) => m.channel)).toEqual(["U_REP_42", "U_REP_41", "U_MGR_EMEA_COM"]);

    clock.t = NOW + 482 * MIN;
    await e.handle({ action: "tick" });
    const s = (await e.handle({ action: "status", runId: "lead" })).body;
    expect(action(s, "sla.escalate:500").status).toBe("applied");
    expect(s.phase).toBe("DONE");
  });

  it("a lead touched within the SLA is left alone", async () => {
    const clock = { t: NOW };
    const e = w.engine(leadRoutingSla, { now: () => clock.t });
    await e.handle({ action: "start", runId: "lead", input: input(), requestedBy: user });
    w.state.hubspot.contacts[0].properties.notes_last_contacted = new Date(Date.now() + 1_000).toISOString();
    clock.t = NOW + 241 * MIN;
    await e.handle({ action: "tick" });
    const s = (await e.handle({ action: "status", runId: "lead" })).body;
    expect(action(s, "sla.first_touch:500")).toMatchObject({ status: "skipped", detail: { reason: "touched within the SLA" } });
    expect(action(s, "sla.escalate:500").status).toBe("skipped");
    expect(w.state.hubspot.contacts[0].properties.hubspot_owner_id).toBe("42");
  });

  it("a colleague's owner gets the lead (account-based routing)", async () => {
    w.state.hubspot.contacts.push(contact("503", { email: "lee@northwind.example", hs_email_domain: "northwind.example", hubspot_owner_id: "41" }));
    const r = await w.engine(leadRoutingSla, { now: () => NOW }).handle({ action: "start", runId: "lead", input: input(), requestedBy: user });
    expect(r.body.output).toMatchObject({ owner: "41", how: "account_owner" });
  });

  it("a lead someone claimed meanwhile is not taken from them", async () => {
    const e = w.engine(leadRoutingSla, { now: () => NOW });
    w.faults.push({ method: "GET", path: /^\/crm\/v3\/objects\/contacts\/500$/, status: 200, body: { id: "500", properties: { email: "kim@northwind.example", country: "DE", numberofemployees: "300" } }, times: 1 });
    w.state.hubspot.contacts[0].properties.hubspot_owner_id = "77";
    const r = await e.handle({ action: "start", runId: "lead", input: input(), requestedBy: user });
    expect(action(r.body, "hubspot.assign:500")).toMatchObject({ status: "skipped", detail: { reason: "claimed by 77 meanwhile" } });
  });
});
