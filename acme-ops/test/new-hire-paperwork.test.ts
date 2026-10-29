import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePolicy } from "../src/kit/policy";
import { newHirePaperwork } from "../src/workflows/new-hire-paperwork";
import { NOW, startWorld, type World } from "./fake-world";

process.env.PROVIDER_RETRIES = "0";

const DAY = 86_400_000;
const user = { userId: "U_HRIS_WEBHOOK" };
const date = (days: number) => new Date(NOW + days * DAY).toISOString().slice(0, 10);
const action = (body: any, id: string) => body.actions.find((a: any) => a.id === id);
const input = (over: object = {}) => ({ hireId: "H-1042", employee: { name: "Priya Rao", email: "priya.rao@gmail.example" }, country: "US", employmentType: "full_time", startDate: date(14), manager: { name: "Lee Park", email: "lee@acme.example" }, ...over });
const start = (runId = "n1", over: object = {}) => ({ action: "start" as const, runId, input: input(over), requestedBy: user });
const connect = (runId: string, value: "approve" | "reject" = "approve", userId = "docusign-connect") => ({ action: "signal" as const, runId, actionId: "docusign.packet_completed", value, userId });

describe("new-hire-paperwork", () => {
  let w: World;
  beforeEach(async () => {
    w = await startWorld();
    w.state.slack.channels.add("C0PEOPLEOPS");
  });
  afterEach(() => w.close());

  it("sends the country/type packet with DocuSign reminders, then files the signed packet when Connect reports completion", async () => {
    const clock = { t: NOW };
    const e = w.engine(newHirePaperwork, { now: () => clock.t });
    const r = await e.handle(start());
    expect(r.body.output).toEqual({ mode: "packet", packet: "US employee", documents: 3 });
    const env = w.state.docusign.envelopes[0];
    expect(env.templateIds).toEqual(["us-offer-letter-template-id", "us-pii-agreement-template-id", "us-handbook-ack-template-id"]);
    expect(env.signers.map((s: any) => [s.roleName, s.email, s.routingOrder])).toEqual([["Employee", "priya.rao@gmail.example", "1"], ["People Team", "people@acme.example", "2"]]);
    expect(env.emailSubject).toBe("Your Acme paperwork, Priya");
    expect(env.notification).toMatchObject({ reminders: { reminderDelay: "2", reminderFrequency: "2" }, expirations: { expireAfter: "21" } });
    expect(action(r.body, "docusign.packet_completed").status).toBe("awaiting_signal");

    Object.assign(env, { status: "completed", completedDateTime: `${date(3)}T10:00:00Z` });
    const done = await e.handle(connect("n1"));
    expect(action(done.body, "docusign.packet_completed")).toMatchObject({ status: "applied", detail: { path: `People/Onboarding/US/${date(14).slice(0, 4)}/Priya Rao (H-1042)/${date(3)} Onboarding paperwork - Priya Rao.pdf` } });
    expect(w.state.box.files[0]).toMatchObject({ name: `${date(3)} Onboarding paperwork - Priya Rao.pdf`, content: `%PDF-1.4 ${env.envelopeId} certificate=true` });
    clock.t = NOW + 13 * DAY;
    await e.handle({ action: "tick" });
    const s = (await e.handle({ action: "status", runId: "n1" })).body;
    expect(s.actions.filter((a: any) => a.kind === "people.unsigned_reminder").map((a: any) => a.status)).toEqual(["skipped", "skipped"]);
    expect(action(s, "people.packet_not_completed").status).toBe("skipped");
    expect(w.state.slack.messages).toHaveLength(0);
  });

  it("never trusts the Connect signal alone: DocuSign must say completed before anything is filed", async () => {
    const e = w.engine(newHirePaperwork, { now: () => NOW });
    await e.handle(start());
    const r = await e.handle(connect("n1"));
    expect(action(r.body, "docusign.packet_completed")).toMatchObject({ status: "failed" });
    expect(action(r.body, "docusign.packet_completed").error).toMatch(/DocuSign says sent/);
    expect(w.state.box.files).toHaveLength(0);
    expect(w.state.slack.messages.at(-1).text).toMatch(/isn't signed and filed by the start date/);
  });

  it("only the Connect adapter may signal completion", async () => {
    const e = w.engine(newHirePaperwork, { now: () => NOW });
    await e.handle(start());
    expect((await e.handle(connect("n1", "approve", "U_SOMEONE"))).status).toBe(403);
  });

  it("reminds People Ops before the start date while unsigned, then escalates when the start date passes", async () => {
    const clock = { t: NOW };
    const e = w.engine(newHirePaperwork, { now: () => clock.t });
    await e.handle(start());
    clock.t = Date.parse(`${date(7)}T16:00:00Z`);
    await e.handle({ action: "tick" });
    expect(w.state.slack.messages.at(-1)).toMatchObject({ channel: "C0PEOPLEOPS" });
    expect(w.state.slack.messages.at(-1).text).toMatch(/starts .* \(7 day\(s\)\) and hasn't finished their paperwork \(DocuSign: sent\)\. Manager: Lee Park/);
    clock.t = Date.parse(`${date(12)}T16:00:00Z`);
    await e.handle({ action: "tick" });
    expect(w.state.slack.messages.at(-1).text).toMatch(/\(2 day\(s\)\)/);
    clock.t = Date.parse(`${date(14)}T16:00:00Z`);
    await e.handle({ action: "tick" });
    const s = (await e.handle({ action: "status", runId: "n1" })).body;
    expect(action(s, "docusign.packet_completed").status).toBe("failed");
    expect(w.state.slack.messages.at(-1).text).toMatch(/isn't signed and filed by the start date\. Start date .*; manager Lee Park/);
    expect(w.state.slack.messages).toHaveLength(3);
  });

  it("a declined or voided envelope is escalated at once", async () => {
    const e = w.engine(newHirePaperwork, { now: () => NOW });
    await e.handle(start());
    const r = await e.handle(connect("n1", "reject"));
    expect(action(r.body, "docusign.packet_completed").status).toBe("rejected");
    expect(w.state.slack.messages.at(-1).text).toMatch(/was declined or voided/);
  });

  it("a re-delivered hire event (new run) reuses the envelope already sent", async () => {
    const e = w.engine(newHirePaperwork, { now: () => NOW });
    await e.handle(start("n1"));
    const again = await e.handle(start("n2"));
    expect(again.body.output).toMatchObject({ mode: "existing_envelope" });
    expect(action(again.body, "docusign.send_packet")).toMatchObject({ status: "applied", detail: { reused: true } });
    expect(w.state.docusign.envelopes).toHaveLength(1);
  });

  it("contractors get their own packet; a hire no packet matches gets nothing and People Ops is told", async () => {
    const e = w.engine(newHirePaperwork, { now: () => NOW });
    expect((await e.handle(start("c", { employmentType: "contractor", country: "DE" }))).body.output).toMatchObject({ packet: "Contractor", documents: 1 });
    const none = await e.handle(start("d", { hireId: "H-2001", country: "DE", employmentType: "full_time" }));
    expect(none.body.output).toEqual({ mode: "no_packet" });
    expect(w.state.docusign.envelopes).toHaveLength(1);
    expect(w.state.slack.messages.at(-1).text).toMatch(/No paperwork packet matches .*DE, full_time/);
  });

  it("a start date inside the minimum lead time sends nothing automatically", async () => {
    const r = await w.engine(newHirePaperwork, { now: () => NOW }).handle(start("n1", { startDate: date(1) }));
    expect(r.body.actions.map((a: any) => a.id)).toEqual(["slack.post_too_late"]);
    expect(w.state.docusign.envelopes).toHaveLength(0);
  });

  it("DocuSign unreachable: nothing sent, People Ops told", async () => {
    const r = await w.engine(newHirePaperwork, { now: () => NOW, only: ["slack", "box"] }).handle(start());
    expect(r.body.output).toEqual({ mode: "blocked" });
    expect(w.state.slack.messages.at(-1).text).toMatch(/Couldn't check DocuSign/);
  });

  it("a deployment's policy adds a country packet and files to Dropbox, without code changes", async () => {
    const p = resolvePolicy(newHirePaperwork.policy!, {
      POLICY_JSON: JSON.stringify({ store: { provider: "dropbox", root: "/HR" }, countersigner: null, packets: [{ name: "DE employee", match: { country: ["DE"] }, templates: ["de-arbeitsvertrag"] }], escalateDaysBeforeStart: [3] }),
    });
    const e = w.engine(newHirePaperwork, { now: () => NOW, policy: p });
    const r = await e.handle(start("n1", { country: "DE" }));
    expect(r.body.output).toMatchObject({ packet: "DE employee", documents: 1 });
    expect(w.state.docusign.envelopes[0].signers).toHaveLength(1);
    expect(r.body.actions.filter((a: any) => a.kind === "people.unsigned_reminder").map((a: any) => a.id)).toEqual(["people.unsigned_reminder:3"]);
    Object.assign(w.state.docusign.envelopes[0], { status: "completed", completedDateTime: `${date(2)}T10:00:00Z` });
    await e.handle(connect("n1"));
    expect(w.state.dropbox.entries.find((x) => x.tag === "file")?.path).toBe(`/HR/People/Onboarding/DE/${date(14).slice(0, 4)}/Priya Rao (H-1042)/${date(2)} Onboarding paperwork - Priya Rao.pdf`);
  });

  it("no packet is decided from policy alone, even when DocuSign is down", async () => {
    const r = await w.engine(newHirePaperwork, { now: () => NOW, only: ["slack"] }).handle(start("n1", { country: "DE" }));
    expect(r.body.output).toEqual({ mode: "no_packet" });
    expect(r.body.actions.map((a: any) => [a.id, a.status])).toEqual([["slack.post_no_packet", "applied"]]);
  });

  it("rejects bad input before anything runs", async () => {
    const r = await w.engine(newHirePaperwork, { now: () => NOW }).handle(start("n1", { country: "usa" }));
    expect(r.status).toBe(400);
  });
});
