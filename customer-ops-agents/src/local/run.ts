// npm run local -- [--live-llm] [--reject] "request text"
//
// Drives the real engine in-process through the same JSON commands LoopLabs
// sends, against fake Stripe/HubSpot/Gmail/Slack. With --live-llm it calls the
// real Claude API (needs ANTHROPIC_API_KEY); otherwise a scripted fake answers.
import { ClaudeLlm } from "../lib/llm";
import { Engine } from "../workflow/engine";
import { fakeWorld } from "./fake-deps";

const args = process.argv.slice(2);
const live = args.includes("--live-llm");
const reject = args.includes("--reject");
const text =
  args.filter((a) => !a.startsWith("--")).join(" ") ||
  "Dana (dana@acme.test) wants 20 pro seats and the onboarding package, 10% off. Check billing and send a survey.";

const world = fakeWorld(live ? { llm: new ClaudeLlm(process.env.ANTHROPIC_API_KEY ?? "", process.env.CLAUDE_MODEL || "claude-opus-5-5") } : {});
const engine = new Engine(world.deps);
const show = (label: string, body: unknown) => console.log(`\n→ ${label}\n${JSON.stringify(body, null, 2)}`);

const runId = `local-${Date.now()}`;
const root = await world.chat.post("C-LOCAL", `<@U-LOCAL> asked: ${text}`);
const started = await engine.handle({ action: "start", runId, requestText: text, requestedBy: { userId: "U-LOCAL" }, slack: { channel: "C-LOCAL", threadTs: root.ts }, wait: true });
show(`start (wait) → ${(started as { phase: string }).phase}`, started);

const decided = await engine.handle({ action: "decide", runId, decision: reject ? "reject" : "approve", userId: "U-APPROVER", wait: true });
show("decide", decided);

console.log("\n=== Slack thread (fake) ===\n");
for (const m of world.chat.messages) console.log(`${m.threadTs ? "  ↳ " : ""}${m.text.replaceAll("\n", `\n${m.threadTs ? "    " : ""}`)}\n`);
console.log("Side effects:", {
  hubspotContacts: world.crm.contacts.size,
  hubspotTasks: world.crm.tasks.length,
  stripeCustomers: world.billing.customers.size,
  stripeQuotes: [...world.billing.quotes.values()].map((q) => `${q.id}:${q.status}`),
  emailsSent: world.mail.sent.map((s) => `${s.to} — ${s.subject}`),
});
