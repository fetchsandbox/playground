import { describe, expect, it } from "vitest";
import { type Starter, handleIngress } from "../src/handlers/ingress-core";
import { signSlackBody } from "../src/lib/slack-verify";
import { fakeWorld } from "../src/local/fake-deps";
import { approvalKey } from "../src/workflow/approval";
import type { WorkflowInput } from "../src/types";

const SECRET = "test-signing-secret";

/** Emulates Step Functions Standard: same name + same input is a no-op, same name + other input is rejected. */
class FakeStarter implements Starter {
  executions = new Map<string, string>();
  attempts = 0;
  async start(name: string, input: WorkflowInput) {
    this.attempts++;
    const prior = this.executions.get(name);
    if (prior !== undefined && prior !== JSON.stringify(input)) throw Object.assign(new Error("exists"), { name: "ExecutionAlreadyExists" });
    this.executions.set(name, JSON.stringify(input));
  }
}

function signed(path: string, rawBody: string, now = Math.floor(Date.now() / 1000)) {
  return { path, rawBody, headers: { "x-slack-request-timestamp": String(now), "x-slack-signature": signSlackBody(SECRET, rawBody, now) } };
}

function setup() {
  const world = fakeWorld();
  const starter = new FakeStarter();
  const callbacks = { calls: 0, async success() { this.calls++; } };
  return { world, starter, callbacks, x: { signingSecret: SECRET, deps: world.deps, starter, callbacks } };
}

const mention = (eventId: string) =>
  JSON.stringify({ type: "event_callback", event_id: eventId, event_time: 1_760_000_000, event: { type: "app_mention", user: "U1", text: "<@UBOT> quote 5 pro seats for a@b.co", channel: "C1", ts: "1.1" } });

describe("Slack ingress", () => {
  it("rejects unsigned requests", async () => {
    const { x } = setup();
    const res = await handleIngress({ path: "/slack/events", rawBody: "{}", headers: {} }, x);
    expect(res.status).toBe(401);
  });

  it("answers the url_verification handshake", async () => {
    const { x } = setup();
    const res = await handleIngress(signed("/slack/events", JSON.stringify({ type: "url_verification", challenge: "abc" })), x);
    expect(JSON.parse(res.body!)).toEqual({ challenge: "abc" });
  });

  it("turns Slack's retried deliveries of one event into a single execution", async () => {
    const { x, starter } = setup();
    const results = await Promise.all([1, 2, 3].map(() => handleIngress(signed("/slack/events", mention("Ev123")), x)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(starter.attempts).toBe(3);
    expect(starter.executions.size).toBe(1); // deterministic name + identical input
  });

  it("ignores bot messages to avoid feedback loops", async () => {
    const { x, starter } = setup();
    const body = JSON.stringify({ type: "event_callback", event_id: "Ev9", event: { type: "app_mention", bot_id: "B1", text: "hi", channel: "C1", ts: "1" } });
    await handleIngress(signed("/slack/events", body), x);
    expect(starter.executions.size).toBe(0);
  });

  it("debounces an accidental double-submit of the same slash command", async () => {
    const { x, starter } = setup();
    const cmd = (trigger: string) => new URLSearchParams({ command: "/ops", text: "quote 5 pro seats for a@b.co", user_id: "U1", channel_id: "C1", trigger_id: trigger }).toString();
    const [a, b] = await Promise.all([handleIngress(signed("/slack/commands", cmd("1.2.a")), x), handleIngress(signed("/slack/commands", cmd("1.2.b")), x)]);
    const texts = [a, b].map((r) => JSON.parse(r.body!).text as string);
    expect(texts.filter((t) => t.startsWith("On it"))).toHaveLength(1);
    expect(texts.filter((t) => t.includes("already running"))).toHaveLength(1);
    expect(starter.executions.size).toBe(1);
  });

  it("records only one decision when two approvers click at the same moment", async () => {
    const { x, world, callbacks } = setup();
    await world.store.put({ pk: approvalKey("run-1"), status: "PENDING", taskToken: "tok", channel: "C1", threadTs: "1.1", expiresAt: Date.now() + 60_000 });
    const click = (user: string, action: string) =>
      handleIngress(signed("/slack/interactions", new URLSearchParams({ payload: JSON.stringify({ type: "block_actions", user: { id: user }, channel: { id: "C1" }, message: { ts: "2.2" }, actions: [{ action_id: action, value: "run-1" }] }) }).toString()), x);
    await Promise.all([click("U-alice", "approve"), click("U-bob", "reject"), click("U-alice", "approve")]);
    expect(callbacks.calls).toBe(1);
    const rec = await world.store.get(approvalKey("run-1"));
    expect(["APPROVED", "REJECTED"]).toContain(rec?.status);
    expect(world.chat.messages.filter((m) => m.text.startsWith("(ephemeral) Already"))).toHaveLength(2);
  });
});
