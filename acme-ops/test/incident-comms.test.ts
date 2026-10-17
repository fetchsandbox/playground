import { describe, expect, it } from "vitest";
import { incidentComms } from "../src/workflows/incident-comms";

const event = {
  incident: { id: "PT4KHLK", title: "API latency", service: "Monitoring API", urgency: "high", status: "triggered" },
  warRoomChannel: "C0INCIDENT",
};

describe("incident-comms input and gating", () => {
  it("accepts a PagerDuty incident and rejects malformed ids and products", () => {
    expect(incidentComms.input.safeParse(event).success).toBe(true);
    expect(incidentComms.input.safeParse({ ...event, incident: { ...event.incident, id: "pt-1" } }).success).toBe(false);
    expect(incidentComms.input.safeParse({ ...event, affectedProductIds: ["monitoring"] }).success).toBe(false);
  });

  it("customer notices are approval-gated drafts; internal updates are automatic", () => {
    const gate = Object.fromEntries(incidentComms.catalog.map((c) => [c.kind, c.gate]));
    expect(gate).toEqual({ "slack.war_room_update": "auto", "pagerduty.timeline_note": "auto", "gmail.draft_customer_notice": "approval" });
  });
});
