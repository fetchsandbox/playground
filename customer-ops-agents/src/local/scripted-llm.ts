// Deterministic stand-in for Claude, so the whole workflow (and its race and
// retry tests) runs offline and for free. It answers each `task` with simple
// heuristics; it is not meant to be smart, only shape-correct.
import type { z } from "zod";
import type { AgentRequest, Llm, StructuredRequest } from "../lib/llm";

type Handler = (prompt: string) => unknown;

const words = (s: string) => s.toLowerCase().match(/[a-z]+/g) ?? [];

export const defaultScript: Record<string, Handler> = {
  intake(prompt) {
    const text = prompt.split("<slack_request>")[1] ?? prompt;
    const email = /[\w.+-]+@[\w-]+\.[\w.]+/.exec(text)?.[0] ?? "";
    const items = [...text.matchAll(/(\d+)\s+([a-z][a-z -]*?(?:seats?|package|add-?on))/gi)].map((m) => ({ description: m[2]!.trim(), quantity: Number(m[1]) }));
    if (/onboarding/i.test(text) && !items.some((i) => /onboarding/i.test(i.description))) items.push({ description: "onboarding package", quantity: 1 });
    const pct = Number(/(\d+)\s*%/.exec(text)?.[1] ?? 0);
    return {
      customer: { email, name: "Dana Scully", company: "Acme" },
      summary: text.trim().split("\n")[0]!.slice(0, 120),
      urgency: /urgent|asap/i.test(text) ? "high" : "normal",
      tasks: {
        research: true,
        billing: /bill|invoice|payment/i.test(text),
        survey: /survey|feedback|nps/i.test(text),
        quote: { needed: items.length > 0, items, requestedDiscountPct: pct },
      },
    };
  },
  "research-brief": () => ({
    accountSummary: "Acme is evaluating a team-wide rollout.",
    recentInteractions: ["2026-10-01: asked about SSO timeline"],
    openDeals: [],
    risks: ["SSO is a blocker for rollout"],
    opportunities: ["SSO add-on"],
  }),
  "quote-map"(prompt) {
    const catalog = JSON.parse(prompt.split("\n")[1]!) as { priceId: string; product: string }[];
    const requested = JSON.parse(prompt.split("<requested_items>\n")[1]!.split("\n</requested_items>")[0]!) as { description: string; quantity: number }[];
    const lines: { priceId: string; quantity: number }[] = [];
    const unmatched: string[] = [];
    for (const r of requested) {
      const hit = catalog.find((c) => words(c.product).some((w) => w.length > 2 && words(r.description).some((x) => x.startsWith(w) || w.startsWith(x))));
      if (hit) lines.push({ priceId: hit.priceId, quantity: r.quantity });
      else unmatched.push(r.description);
    }
    return { lines, unmatched };
  },
  "billing-assess": (prompt) => {
    const overdue = (JSON.parse(prompt) as { computed: { overdueInvoices: number } }).computed.overdueInvoices;
    return { health: overdue ? "at_risk" : "good", notes: overdue ? `${overdue} overdue invoice(s)` : "Paid up.", proposedActions: overdue ? ["Chase overdue invoice before sending a new quote"] : [] };
  },
  survey: () => ({ subject: "Two minutes to tell us how we're doing?", intro: "Thanks for working with us!", questions: ["How likely are you to recommend us (0-10)?", "What should we improve?"] }),
  handoff: (prompt) => ({
    summary: `Handoff prepared. Agent results: ${/"status":"failed"/.test(prompt) ? "some agents failed — see notes" : "all agents succeeded"}.`,
    nextSteps: ["Review quote with customer", "Confirm SSO timeline"],
    riskLevel: /"status":"failed"/.test(prompt) ? "medium" : "low",
    customerEmail: { subject: "Your quote from Example Co", body: "Hi Dana,\n\nPlease find your quote attached.\n\nBest,\nThe team" },
  }),
};

export class ScriptedLlm implements Llm {
  calls: string[] = [];
  constructor(private readonly script: Record<string, Handler> = defaultScript) {}

  async structured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<z.infer<S>> {
    this.calls.push(req.task);
    await new Promise((r) => setImmediate(r));
    const h = this.script[req.task];
    if (!h) throw new Error(`ScriptedLlm has no handler for task ${req.task}`);
    return req.schema.parse(h(req.prompt)); // same validation the real structured output gets
  }

  async runAgent(req: AgentRequest): Promise<string> {
    this.calls.push(req.task);
    // Exercise every tool once, like a diligent agent would.
    const results = await Promise.all(req.tools.map(async (t) => `${t.name}: ${JSON.stringify(await t.run({}))}`));
    return results.join("\n");
  }
}
