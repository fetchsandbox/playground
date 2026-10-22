import { z } from "zod";
import { FatalError, SkipAction } from "../kit/errors";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import type { HubSpotContact } from "../providers/hubspot";
import { ChannelId, Email, out, shortHash } from "./shared";

// Sales · revops.
// Trigger: an inbound lead (HubSpot form submission). Speed to first touch is
// what converts, so routing is fair and enforced:
//   - a lead from a company we already work with goes to that account's owner;
//   - otherwise to the least-loaded rep of the territory pod (region × segment);
//   - the rep gets a Slack DM, and a durable SLA timer starts (enterprise 1 h,
//     commercial 4 h);
//   - at the SLA, a lead nobody has touched is reassigned to the next
//     least-loaded rep and the pod manager is told; a second miss escalates
//     to the manager only.
// Duplicate submissions of a lead already owned are not re-routed.

export const POLICY = {
  slaMinutes: { enterprise: 60, commercial: 240 },
  enterpriseEmployees: 1_000,
  /** Free-mail domains are never matched to an account. */
  freeMail: ["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "proton.me"],
} as const;

const Region = z.enum(["NA", "EMEA", "APAC"]);
const Pod = z.object({ reps: z.array(z.object({ ownerId: z.string().regex(/^\d{1,12}$/), slackId: z.string().regex(/^U[A-Z0-9_]+$/) })).min(1).max(50), managerSlackId: z.string().regex(/^U[A-Z0-9_]+$/) });
const Input = z.object({
  contactId: z.string().regex(/^\d{1,12}$/),
  /** The territory plan: pods by region and segment. */
  pods: z.object({ NA: z.object({ enterprise: Pod, commercial: Pod }), EMEA: z.object({ enterprise: Pod, commercial: Pod }), APAC: z.object({ enterprise: Pod, commercial: Pod }) }),
  /** Country code → region; others go to NA. */
  regions: z.record(z.string().regex(/^[A-Z]{2}$/), Region).default({}),
  salesChannel: ChannelId,
});
type Input = z.infer<typeof Input>;

export interface Lead {
  id: string;
  email: string;
  domain: string | null;
  country: string | null;
  employees: number | null;
  ownerId: string | null;
}
export interface Routing {
  mode: "route" | "already_owned" | "blocked";
  reason: string;
  region: z.infer<typeof Region>;
  segment: "enterprise" | "commercial";
  ownerId: string | null;
  backupOwnerId: string | null;
  how: "account_owner" | "least_loaded" | "none";
  slaMinutes: number;
}

/** Routing decision. Pure: the territory plan, the account owner and current loads decide. */
export function route(input: Input, lead: Lead | undefined, accountOwner: string | null, loads: Record<string, number> | undefined): Routing {
  const region = (lead?.country && input.regions[lead.country.toUpperCase()]) || "NA";
  const segment = (lead?.employees ?? 0) >= POLICY.enterpriseEmployees ? "enterprise" : "commercial";
  const slaMinutes = POLICY.slaMinutes[segment];
  const base = { region, segment, slaMinutes, backupOwnerId: null } as const;
  if (!lead) return { ...base, mode: "blocked", reason: "lead could not be read", ownerId: null, how: "none" };
  if (lead.ownerId) return { ...base, mode: "already_owned", reason: `already owned by ${lead.ownerId}`, ownerId: lead.ownerId, how: "none" };
  const pod = input.pods[region][segment];
  if (!loads) return { ...base, mode: "blocked", reason: "rep workloads could not be read", ownerId: null, how: "none" };
  // Least loaded first, ties broken by the order of the territory plan (stable, not random).
  const ranked = pod.reps.map((r, i) => ({ id: r.ownerId, load: loads[r.ownerId] ?? 0, i })).sort((a, b) => a.load - b.load || a.i - b.i).map((r) => r.id);
  if (accountOwner && pod.reps.some((r) => r.ownerId === accountOwner)) return { ...base, mode: "route", reason: "existing account", ownerId: accountOwner, backupOwnerId: ranked.find((id) => id !== accountOwner) ?? null, how: "account_owner" };
  if (accountOwner) return { ...base, mode: "route", reason: "existing account (owner outside this pod)", ownerId: accountOwner, backupOwnerId: ranked[0] ?? null, how: "account_owner" };
  return { ...base, mode: "route", reason: "least-loaded rep in the pod", ownerId: ranked[0]!, backupOwnerId: ranked[1] ?? null, how: "least_loaded" };
}

const toLead = (c: HubSpotContact): Lead => {
  const email = (c.properties.email ?? "").toLowerCase();
  const domain = c.properties.hs_email_domain?.toLowerCase() || email.split("@")[1] || null;
  return { id: c.id, email, domain, country: c.properties.country ?? null, employees: c.properties.numberofemployees ? Number(c.properties.numberofemployees) : null, ownerId: c.properties.hubspot_owner_id || null };
};

export const leadRoutingSla: WorkflowDef<Input> = {
  id: "lead-routing-sla",
  title: "Lead routing with first-touch SLA",
  org: "Sales",
  team: "revops",
  description:
    "Route an inbound HubSpot lead to its account owner or the least-loaded rep of its territory pod, DM the rep, and enforce the first-touch SLA with a durable timer: an untouched lead is reassigned and the manager told, a second miss escalates.",
  input: Input,
  audit: true,
  tickEvery: "rate(5 minutes)",
  agents: [
    {
      name: "lead",
      needs: ["hubspot"],
      async run({ input, providers }) {
        const lead = toLead(await providers.hubspot!.get(input.contactId));
        let accountOwner: string | null = null;
        if (lead.domain && !(POLICY.freeMail as readonly string[]).includes(lead.domain)) {
          const colleagues = await providers.hubspot!.searchAll([{ propertyName: "hs_email_domain", operator: "EQ", value: lead.domain }, { propertyName: "hubspot_owner_id", operator: "HAS_PROPERTY" }], 200);
          const owners = colleagues.filter((c) => c.id !== lead.id).map((c) => c.properties.hubspot_owner_id!).filter(Boolean);
          // The owner with most contacts at the company owns the account.
          const counts = new Map<string, number>();
          for (const o of owners) counts.set(o, (counts.get(o) ?? 0) + 1);
          accountOwner = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
        }
        return { summary: `${lead.domain ?? "?"}, ${lead.country ?? "?"}, ${lead.employees ?? "?"} employees${accountOwner ? `, account owner ${accountOwner}` : ""}`, data: { lead, accountOwner } };
      },
    },
    {
      name: "workloads",
      needs: ["hubspot"],
      async run({ input, providers }) {
        // Open new leads per rep across every pod (a rep's load counts wherever it comes from).
        const reps = [...new Set(Object.values(input.pods).flatMap((r) => [...r.enterprise.reps, ...r.commercial.reps]).map((r) => r.ownerId))];
        const loads: Record<string, number> = {};
        for (const id of reps) loads[id] = (await providers.hubspot!.searchAll([{ propertyName: "hubspot_owner_id", operator: "EQ", value: id }, { propertyName: "hs_lead_status", operator: "EQ", value: "NEW" }], 1_000)).length;
        return { summary: `${reps.length} rep(s)`, data: loads };
      },
    },
  ],

  compose: {
    name: "routing",
    async run({ input }, results) {
      const l = out<{ lead: Lead; accountOwner: string | null }>(results, "lead");
      const r = route(input, l?.lead, l?.accountOwner ?? null, out<Record<string, number>>(results, "workloads"));
      return { summary: `${r.mode}: ${r.ownerId ?? "-"} (${r.how}, ${r.region}/${r.segment}, SLA ${r.slaMinutes} min)`, data: r };
    },
  },

  plan({ input }, results) {
    const r = out<Routing>(results, "routing");
    const l = out<{ lead: Lead }>(results, "lead");
    if (!r) return [];
    const pod = input.pods[r.region][r.segment];
    const slack = (ownerId: string | null) => pod.reps.find((x) => x.ownerId === ownerId)?.slackId ?? pod.managerSlackId;
    const who = l ? shortHash(l.lead.email).slice(0, 8) : "?";
    const ids = { assign: `hubspot.assign:${input.contactId}`, sla1: `sla.first_touch:${input.contactId}`, sla2: `sla.escalate:${input.contactId}` };
    const actions: PlannedAction<Input>[] = [];
    if (r.mode !== "route") {
      actions.push({
        id: "slack.post_routing",
        kind: "slack.post_routing",
        provider: "slack",
        agent: "routing",
        gate: "auto",
        summary: { channel: input.salesChannel, mode: r.mode },
        async execute({ providers }) {
          const m = await providers.slack!.postMessage(input.salesChannel, `${r.mode === "blocked" ? ":rotating_light:" : ":information_source:"} Lead ${input.contactId}: ${r.reason}.`);
          return { ref: m.ts };
        },
      });
      return actions;
    }
    const touched = async (providers: Parameters<PlannedAction<Input>["execute"]>[0]["providers"], since: string) => {
      const c = await providers.hubspot!.get(input.contactId);
      const last = c.properties.notes_last_contacted ? Date.parse(c.properties.notes_last_contacted) : NaN;
      return { touched: Number.isFinite(last) && last >= Date.parse(since), owner: c.properties.hubspot_owner_id ?? null, status: c.properties.hs_lead_status ?? null };
    };
    actions.push({
      id: ids.assign,
      kind: "hubspot.assign",
      provider: "hubspot",
      agent: "routing",
      gate: "auto",
      summary: { owner: r.ownerId, how: r.how, region: r.region, segment: r.segment },
      async execute({ providers }) {
        // Someone may have claimed the lead since it was read.
        const cur = await providers.hubspot!.get(input.contactId);
        if (cur.properties.hubspot_owner_id && cur.properties.hubspot_owner_id !== r.ownerId) throw new SkipAction(`claimed by ${cur.properties.hubspot_owner_id} meanwhile`);
        await providers.hubspot!.update(input.contactId, { hubspot_owner_id: r.ownerId!, hs_lead_status: "NEW" });
        const m = await providers.slack!.postMessage(slack(r.ownerId), `:dart: New ${r.segment} lead ${who} (${r.reason}). First touch within ${r.slaMinutes} min.`).catch(() => undefined);
        return { ref: input.contactId, detail: { owner: r.ownerId, dm: m?.ts ?? null, at: new Date().toISOString() } };
      },
      async reconcile({ providers }) {
        const c = await providers.hubspot!.get(input.contactId);
        return c.properties.hubspot_owner_id === r.ownerId ? { status: "match" } : { status: "drift", detail: `owner is ${c.properties.hubspot_owner_id}` };
      },
    });
    actions.push({
      id: ids.sla1,
      kind: "sla.first_touch",
      provider: "hubspot",
      agent: "routing",
      gate: "auto",
      summary: { minutes: r.slaMinutes, backup: r.backupOwnerId },
      requires: [ids.assign],
      delayAfter: { action: ids.assign, ms: r.slaMinutes * 60_000 },
      async execute({ providers, applied }) {
        const since = String(applied[ids.assign]?.detail?.at ?? new Date(0).toISOString());
        const t = await touched(providers, since);
        if (t.touched || t.status !== "NEW") throw new SkipAction(t.touched ? "touched within the SLA" : `lead status ${t.status}`);
        if (t.owner !== r.ownerId) throw new SkipAction(`reassigned by hand to ${t.owner}`);
        if (!r.backupOwnerId) throw new FatalError("SLA missed and no backup rep in the pod");
        await providers.hubspot!.update(input.contactId, { hubspot_owner_id: r.backupOwnerId });
        await providers.slack!.postMessage(slack(r.backupOwnerId), `:dart: Reassigned lead ${who}: first-touch SLA (${r.slaMinutes} min) missed. Please reach out now.`).catch(() => undefined);
        await providers.slack!.postMessage(pod.managerSlackId, `:alarm_clock: Lead ${who} missed its ${r.slaMinutes}-min first-touch SLA with ${r.ownerId}; reassigned to ${r.backupOwnerId}.`);
        return { ref: input.contactId, detail: { reassignedTo: r.backupOwnerId } };
      },
    });
    actions.push({
      id: ids.sla2,
      kind: "sla.escalate",
      provider: "hubspot",
      agent: "routing",
      gate: "auto",
      summary: { minutes: r.slaMinutes },
      requires: [ids.sla1],
      delayAfter: { action: ids.sla1, ms: r.slaMinutes * 60_000 },
      async execute({ providers, applied }) {
        const since = String(applied[ids.assign]?.detail?.at ?? new Date(0).toISOString());
        const t = await touched(providers, since);
        if (t.touched || t.status !== "NEW") throw new SkipAction("touched after reassignment");
        const m = await providers.slack!.postMessage(pod.managerSlackId, `:rotating_light: Lead ${who} is still untouched after reassignment to ${r.backupOwnerId}. Please take it.`);
        return { ref: m.ts };
      },
    });
    return actions;
  },

  output(_ctx, results) {
    const r = out<Routing>(results, "routing");
    return r ? { mode: r.mode, owner: r.ownerId, how: r.how, region: r.region, segment: r.segment, slaMinutes: r.slaMinutes } : { mode: "not decided" };
  },

  catalog: [
    { kind: "hubspot.assign", provider: "hubspot", gate: "auto", description: "Assign the owner (unless someone claimed the lead meanwhile) and DM the rep" },
    { kind: "sla.first_touch", provider: "hubspot", gate: "auto", description: "At the SLA: an untouched lead is reassigned to the backup rep and the manager told" },
    { kind: "sla.escalate", provider: "hubspot", gate: "auto", description: "A second miss escalates to the manager" },
    { kind: "slack.post_routing", provider: "slack", gate: "auto", description: "Blocked or already-owned leads posted to sales" },
  ],
};
