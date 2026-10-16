// npm run local -- [--live-llm] [--reject] "request text"
//
// Runs the full workflow in-process against fake Stripe/HubSpot/Gmail/Slack.
// With --live-llm it calls the real Claude API (needs ANTHROPIC_API_KEY);
// otherwise a scripted fake answers. Prints the Slack thread at the end.
import { ClaudeLlm } from "../lib/llm";
import { decideApproval } from "../workflow/approval";
import { fakeWorld } from "./fake-deps";
import { LocalTaskBroker, runWorkflowLocally } from "./orchestrator";

const args = process.argv.slice(2);
const live = args.includes("--live-llm");
const reject = args.includes("--reject");
const text =
  args.filter((a) => !a.startsWith("--")).join(" ") ||
  "Dana (dana@acme.test) wants 20 pro seats and the onboarding package, 10% off. Check billing and send a survey.";

const world = fakeWorld(live ? { llm: new ClaudeLlm(process.env.ANTHROPIC_API_KEY ?? "", process.env.CLAUDE_MODEL || "claude-opus-5-5") } : {});
const root = await world.chat.post("C-LOCAL", `<@U-LOCAL> asked: ${text}`);
const broker = new LocalTaskBroker();

const result = await runWorkflowLocally(
  { runId: `local-${Date.now()}`, requestText: text, requestedBy: { userId: "U-LOCAL" }, slack: { channel: "C-LOCAL", threadTs: root.ts }, receivedAt: new Date().toISOString() },
  world.deps,
  {
    broker,
    approvalTimeoutMs: 60_000,
    onApprovalRequested: (runId) => void decideApproval(runId, reject ? "reject" : "approve", "U-APPROVER", world.deps, broker),
  },
);

console.log(`\n=== terminal state: ${result.terminal} ===\n`);
for (const m of world.chat.messages) {
  const body = m.blocks ? (m.blocks[0] as { text?: { text: string } }).text?.text ?? m.text : m.text;
  console.log(`${m.threadTs ? "  ↳ " : ""}${body.replaceAll("\n", `\n${m.threadTs ? "    " : ""}`)}\n`);
}
console.log("Side effects:", {
  hubspotContacts: world.crm.contacts.size,
  hubspotDeals: world.crm.deals.size,
  hubspotTasks: world.crm.tasks.length,
  stripeCustomers: world.billing.customers.size,
  stripeQuotes: [...world.billing.quotes.values()].map((q) => `${q.id}:${q.status}`),
  emailsSent: world.mail.sent.map((s) => `${s.to} — ${s.subject}`),
});
