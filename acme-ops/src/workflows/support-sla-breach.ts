import { z } from "zod";
import { SkipAction } from "../kit/errors";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import type { Providers } from "../providers";
import type { ZendeskTicket } from "../providers/zendesk";
import { ChannelId, out, shortHash } from "./shared";

// Support · support-ops.
// Trigger: the 15-minute SLA sweep. Every open ticket in scope that hasn't had
// a first public reply from an agent gets two durable timers from its SLA
// target (by customer tier × priority):
//   - at 75% of the target the assignee is warned (internal note + Slack);
//   - at the target the ticket is marked breached and support leads are told;
//     an enterprise breach also pages the support on-call in PagerDuty.
// Each timer re-reads the ticket first: a reply, a solve or a pending status
// stops it. Each step claims the ticket with a compare-and-swap tag
// (Zendesk safe_update), so overlapping sweeps that scheduled the same timers
// fire it once; the page is de-duplicated by incident key. Calendar time is used (24×7 support); business-hours calendars
// are a known limit.

export const TARGET_MINUTES = {
  enterprise: { urgent: 15, high: 60, normal: 120, low: 240 },
  standard: { urgent: 60, high: 240, normal: 480, low: 1440 },
} as const;
export const POLICY = { warnAt: 0.75, maxTickets: 300, warnedTag: "sla_warned", breachedTag: "sla_breached" } as const;
const MIN = 60_000;

const Input = z.object({
  sweepId: z.string().regex(/^SLA-[\w-]{3,40}$/, "sweep id like SLA-2026-10-22T10-15"),
  /** Only tickets carrying this tag are in scope (e.g. one brand or queue). */
  scopeTag: z.string().regex(/^[\w-]{2,60}$/),
  enterpriseTag: z.string().regex(/^[\w-]{2,60}$/).default("tier_enterprise"),
  supportChannel: ChannelId,
  leadsChannel: ChannelId,
  pagerdutyServiceId: z.string().regex(/^P[A-Z0-9]{5,}$/),
  /** Zendesk agent id → Slack user id, for warnings. */
  agentSlack: z.record(z.string().regex(/^\d+$/), z.string().regex(/^U[A-Z0-9_]+$/)).default({}),
});
type Input = z.infer<typeof Input>;

export interface Clock {
  id: number;
  subject: string;
  tier: "enterprise" | "standard";
  priority: keyof (typeof TARGET_MINUTES)["standard"];
  createdAt: string;
  assignee: number | null;
  warned: boolean;
  breached: boolean;
}

export const dueAt = (c: Pick<Clock, "tier" | "priority" | "createdAt">, share = 1) => new Date(Date.parse(c.createdAt) + share * TARGET_MINUTES[c.tier][c.priority] * MIN).toISOString();

/** True once an agent (anyone but the requester) has replied publicly. */
async function answered(providers: Providers, t: ZendeskTicket): Promise<boolean> {
  const comments = await providers.zendesk!.listComments(t.id);
  return comments.some((c) => c.public !== false && c.author_id !== t.requester_id);
}

export const supportSlaBreach: WorkflowDef<Input> = {
  id: "support-sla-breach",
  title: "Support first-response SLA",
  org: "Support",
  team: "support-ops",
  description:
    "Start durable warning and breach timers for every unanswered open ticket from its tier × priority target; warn the assignee at 75%, mark the breach and tell leads at 100%, page on-call for enterprise breaches; each timer re-reads the ticket and fires at most once across overlapping sweeps.",
  input: Input,
  audit: true,
  tickEvery: "rate(5 minutes)",
  agents: [
    {
      name: "queue",
      needs: ["zendesk"],
      async run({ input, providers, checkpoint }) {
        const zd = providers.zendesk!;
        const all = (await zd.listTickets()).filter((t) => (t.tags ?? []).includes(input.scopeTag) && ["new", "open"].includes(t.status ?? ""));
        const seen = (await checkpoint.load<Record<string, Clock | null>>("clocks")) ?? {};
        for (const t of all.slice(0, POLICY.maxTickets)) {
          if (String(t.id) in seen) continue;
          const tags = t.tags ?? [];
          const priority = (["urgent", "high", "normal", "low"].includes(t.priority ?? "") ? t.priority : "normal") as Clock["priority"];
          seen[t.id] = (await answered(providers, t))
            ? null
            : { id: t.id, subject: t.subject ?? "", tier: tags.includes(input.enterpriseTag) ? "enterprise" : "standard", priority, createdAt: t.created_at ?? new Date(0).toISOString(), assignee: t.assignee_id ?? null, warned: tags.includes(POLICY.warnedTag), breached: tags.includes(POLICY.breachedTag) };
          if (Object.keys(seen).length % 50 === 0) await checkpoint.save("clocks", seen);
        }
        await checkpoint.save("clocks", seen);
        const clocks = Object.values(seen).filter((c): c is Clock => !!c);
        return { summary: `${all.length} open ticket(s) in scope, ${clocks.length} awaiting a first reply${all.length > POLICY.maxTickets ? ` (first ${POLICY.maxTickets})` : ""}`, data: { clocks, truncated: all.length > POLICY.maxTickets } };
      },
    },
  ],

  plan({ input, startedAt }, results) {
    const q = out<{ clocks: Clock[]; truncated: boolean }>(results, "queue");
    const post = (text: string): PlannedAction<Input> => ({
      id: "slack.post_sweep",
      kind: "slack.post_sweep",
      provider: "slack",
      agent: "queue",
      gate: "auto",
      summary: { sweepId: input.sweepId },
      async execute({ providers }) {
        return { ref: (await providers.slack!.postMessage(input.supportChannel, text)).ts };
      },
    });
    if (!q) return [post(`:warning: ${input.sweepId}: the ${input.scopeTag} queue could not be read; SLA timers are not running.`)];
    const now = startedAt.getTime();
    const actions: PlannedAction<Input>[] = [];
    /**
     * Re-reads the ticket and claims the step with a compare-and-swap tag, so
     * overlapping sweeps fire it once. Throws SkipAction when the clock stopped
     * or another sweep owns the step; the owner's retries proceed.
     */
    const still = async (providers: Providers, id: number, tag: string, runId: string) => {
      const t = await providers.zendesk!.getTicket(id);
      if (!["new", "open"].includes(t.status ?? "")) throw new SkipAction(`ticket is ${t.status}`);
      if (await answered(providers, t)) throw new SkipAction("agent replied");
      if (!(await providers.zendesk!.claimTag(id, tag, shortHash("sla", runId).slice(0, 8)))) throw new SkipAction(`already ${tag === POLICY.warnedTag ? "warned" : "breached"}`);
      return t;
    };
    for (const c of q.clocks) {
      const due = dueAt(c);
      if (!c.warned && !c.breached && Date.parse(due) > now) {
        actions.push({
          id: `sla.warn:${c.id}`,
          kind: "sla.warn",
          provider: "zendesk",
          agent: "queue",
          gate: "auto",
          summary: { ticket: c.id, tier: c.tier, priority: c.priority, due },
          waitUntil: dueAt(c, POLICY.warnAt),
          async execute({ providers, runId }) {
            const t = await still(providers, c.id, POLICY.warnedTag, runId);
            await providers.zendesk!.addComment(c.id, { body: `SLA: first reply due ${due} (${c.tier} ${c.priority}, ${TARGET_MINUTES[c.tier][c.priority]} min).`, public: false });
            const who = t.assignee_id ? input.agentSlack[String(t.assignee_id)] : undefined;
            await providers.slack!.postMessage(input.supportChannel, `:hourglass_flowing_sand: Ticket ${c.id} (${c.tier}, ${c.priority}) needs a first reply by ${due.slice(11, 16)} UTC. ${who ? `<@${who}>` : "Unassigned."}`);
            return { ref: String(c.id) };
          },
        });
      }
      if (c.breached) continue;
      const breach = `sla.breach:${c.id}`;
      actions.push({
        id: breach,
        kind: "sla.breach",
        provider: "zendesk",
        agent: "queue",
        gate: "auto",
        summary: { ticket: c.id, tier: c.tier, priority: c.priority, due },
        waitUntil: due,
        async execute({ providers, runId }) {
          await still(providers, c.id, POLICY.breachedTag, runId);
          await providers.zendesk!.addComment(c.id, { body: `SLA breached: no first reply by ${due}.`, public: false });
          await providers.slack!.postMessage(input.leadsChannel, `:red_circle: SLA breach: ticket ${c.id} (${c.tier}, ${c.priority}) had no first reply within ${TARGET_MINUTES[c.tier][c.priority]} min.`);
          return { ref: String(c.id) };
        },
      });
      if (c.tier === "enterprise") {
        actions.push({
          id: `pagerduty.page:${c.id}`,
          kind: "pagerduty.page",
          provider: "pagerduty",
          agent: "queue",
          gate: "auto",
          summary: { ticket: c.id, service: input.pagerdutyServiceId },
          requires: [breach],
          async execute({ providers }) {
            const key = `zendesk-sla-${c.id}`;
            const open = (await providers.pagerduty!.openIncidents([input.pagerdutyServiceId])).find((i) => i.incident_key === key);
            if (open) return { ref: open.id, detail: { reused: true } };
            const inc = await providers.pagerduty!.createIncident({ serviceId: input.pagerdutyServiceId, title: `Enterprise SLA breach: Zendesk ticket ${c.id}`, incidentKey: key, details: `${c.priority} ticket with no first reply after ${TARGET_MINUTES.enterprise[c.priority]} min.`, urgency: c.priority === "urgent" || c.priority === "high" ? "high" : "low" });
            return { ref: inc.id };
          },
        });
      }
    }
    const breachedNow = q.clocks.filter((c) => !c.breached && Date.parse(dueAt(c)) <= now).length;
    actions.push(post(`:stopwatch: ${input.sweepId} ${input.scopeTag}: ${q.clocks.length} ticket(s) awaiting a first reply, ${breachedNow} past target.${q.truncated ? ` Only the first ${POLICY.maxTickets} are timed.` : ""}`));
    return actions;
  },

  output({ startedAt }, results) {
    const q = out<{ clocks: Clock[]; truncated: boolean }>(results, "queue");
    if (!q) return { mode: "blocked" };
    const now = startedAt.getTime();
    return { mode: "timing", awaitingReply: q.clocks.length, pastTarget: q.clocks.filter((c) => Date.parse(dueAt(c)) <= now).length, enterprise: q.clocks.filter((c) => c.tier === "enterprise").length, truncated: q.truncated };
  },

  catalog: [
    { kind: "sla.warn", provider: "zendesk", gate: "auto", description: "At 75% of target: internal note, tag and Slack warning" },
    { kind: "sla.breach", provider: "zendesk", gate: "auto", description: "At target: breach tag, note and leads alert" },
    { kind: "pagerduty.page", provider: "pagerduty", gate: "auto", description: "Enterprise breach pages support on-call (de-duplicated)" },
    { kind: "slack.post_sweep", provider: "slack", gate: "auto", description: "Sweep summary" },
  ],
};
