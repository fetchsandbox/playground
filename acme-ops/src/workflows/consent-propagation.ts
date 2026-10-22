import { z } from "zod";
import { SkipAction } from "../kit/errors";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import type { HubSpotContact } from "../providers/hubspot";
import type { StripeCustomer } from "../providers/stripe";
import { ChannelId, Email, out, shortHash } from "./shared";

// Marketing · marketing-ops (with privacy-ops).
// Trigger: a consent change from the preference center (opt-out of marketing
// email, "do not sell or share", profiling). Every system that acts on consent
// must agree, within the regulation's window, and keep the history:
//   - HubSpot contact property per purpose and, for marketing email, the
//     subscription itself (Communication Preferences API);
//   - every Stripe customer with that email (metadata read by billing emails
//     and data exports).
// Events arrive out of order: each write is guarded by the event's timestamp,
// so a stale event never overwrites a newer choice. Fifteen minutes after the
// writes every system is read back; a mismatch is re-applied once and, if it
// persists, escalated. The audit chain records every decision.

export const PURPOSES = ["marketing_email", "sale_or_share", "profiling"] as const;
type Purpose = (typeof PURPOSES)[number];
export const VERIFY_AFTER_MS = 15 * 60_000;

const Input = z.object({
  eventId: z.string().regex(/^evt_[\w-]{6,64}$/, "preference-center event id like evt_..."),
  email: Email,
  occurredAt: z.iso.datetime(),
  source: z.enum(["preference_center", "unsubscribe_link", "support_request", "gpc_signal"]),
  changes: z.array(z.object({ purpose: z.enum(PURPOSES), state: z.enum(["granted", "withdrawn"]) })).min(1).max(PURPOSES.length),
  /** HubSpot subscription type that carries marketing email. */
  marketingSubscriptionId: z.string().regex(/^\d+$/),
  privacyChannel: ChannelId,
});
type Input = z.infer<typeof Input>;

export const prop = (p: Purpose) => `acme_consent_${p}`;
/** Stored value: "<state>@<ISO time>", so every system carries the ordering key with the state. */
export const encode = (state: string, at: string) => `${state}@${at}`;
export const decode = (v: string | null | undefined): { state: string; at: string } | null => {
  const m = /^(granted|withdrawn)@(.+)$/.exec(v ?? "");
  return m ? { state: m[1]!, at: m[2]! } : null;
};

/** Pure: what to do with one stored value given the event. */
export function verdict(stored: string | null | undefined, state: string, at: string): "write" | "same" | "stale" {
  const cur = decode(stored);
  if (!cur) return "write";
  if (Date.parse(cur.at) > Date.parse(at)) return "stale";
  return cur.state === state ? "same" : "write";
}

interface Crm {
  contactId: string | null;
  values: Record<string, string | null>;
  marketingStatus: string | null;
}
interface Billing {
  customers: { id: string; values: Record<string, string | null> }[];
}

export const consentPropagation: WorkflowDef<Input> = {
  id: "consent-propagation",
  title: "Consent change propagation",
  org: "Marketing",
  team: "marketing-ops",
  description:
    "Apply a consent change (marketing email, sale or sharing of data, profiling) to HubSpot (contact property and email subscription) and every Stripe customer with that email, guarded by the event time so stale events never win; read every system back after 15 minutes, re-apply once and escalate a persistent mismatch.",
  input: Input,
  audit: true,
  tickEvery: "rate(5 minutes)",
  agents: [
    {
      name: "crm",
      needs: ["hubspot"],
      async run({ input, providers }) {
        const hs = providers.hubspot!;
        const c = await hs.findByEmail(input.email, PURPOSES.map(prop));
        const marketing = (await hs.subscriptionStatuses(input.email)).find((s) => s.id === input.marketingSubscriptionId)?.status ?? null;
        const data: Crm = { contactId: c?.id ?? null, values: Object.fromEntries(PURPOSES.map((p) => [p, (c?.properties[prop(p)] as string | undefined) ?? null])), marketingStatus: marketing };
        return { summary: c ? `contact ${c.id}, marketing ${marketing ?? "unknown"}` : "no HubSpot contact", data };
      },
    },
    {
      name: "billing",
      needs: ["stripe"],
      async run({ input, providers }) {
        const customers = (await providers.stripe!.findCustomersByEmail(input.email)).filter((c) => c.email?.toLowerCase() === input.email);
        const data: Billing = { customers: customers.map((c) => ({ id: c.id, values: Object.fromEntries(PURPOSES.map((p) => [p, c.metadata?.[prop(p)] ?? null])) })) };
        return { summary: `${customers.length} Stripe customer(s)`, data };
      },
    },
  ],

  plan({ input }, results) {
    const crm = out<Crm>(results, "crm");
    const billing = out<Billing>(results, "billing");
    const actions: PlannedAction<Input>[] = [];
    const at = input.occurredAt;
    const ref = shortHash("consent", input.email).slice(0, 10);
    const writes: string[] = [];

    const hubspotProps = (c: HubSpotContact) => PURPOSES.reduce<Record<string, string | null>>((acc, p) => ({ ...acc, [p]: (c.properties[prop(p)] as string | undefined) ?? null }), {});
    const stripeProps = (c: StripeCustomer) => PURPOSES.reduce<Record<string, string | null>>((acc, p) => ({ ...acc, [p]: c.metadata?.[prop(p)] ?? null }), {});
    /** The properties this event should write given what the system holds now; throws SkipAction if nothing. */
    const toWrite = (held: Record<string, string | null>) => {
      const patch: Record<string, string> = {};
      const stale: string[] = [];
      for (const ch of input.changes) {
        const v = verdict(held[ch.purpose], ch.state, at);
        if (v === "write") patch[prop(ch.purpose)] = encode(ch.state, at);
        if (v === "stale") stale.push(ch.purpose);
      }
      if (!Object.keys(patch).length) throw new SkipAction(stale.length ? `newer consent on record for ${stale.join(", ")}` : "already applied");
      return { patch, stale };
    };

    if (crm?.contactId) {
      const id = crm.contactId;
      const k = `hubspot.consent:${id}`;
      writes.push(k);
      actions.push({
        id: k,
        kind: "hubspot.consent",
        provider: "hubspot",
        agent: "crm",
        gate: "auto",
        summary: { eventId: input.eventId, contact: id, changes: input.changes },
        async execute({ providers }) {
          // Re-read at write time: another event may have landed since discovery.
          const cur = await providers.hubspot!.get(id, PURPOSES.map(prop));
          const { patch, stale } = toWrite(hubspotProps(cur));
          await providers.hubspot!.update(id, { ...patch, acme_consent_last_event: input.eventId });
          return { ref: id, detail: { wrote: Object.keys(patch), stale } };
        },
        async reconcile({ providers }) {
          const cur = hubspotProps(await providers.hubspot!.get(id, PURPOSES.map(prop)));
          const off = input.changes.filter((ch) => verdict(cur[ch.purpose], ch.state, at) === "write");
          return off.length ? { status: "drift", detail: `${off.map((c) => c.purpose).join(", ")} not applied` } : { status: "match" };
        },
      });
    }
    const marketing = input.changes.find((c) => c.purpose === "marketing_email");
    if (marketing && crm) {
      const subscribed = marketing.state === "granted";
      const k = `hubspot.subscription:${input.marketingSubscriptionId}`;
      writes.push(k);
      actions.push({
        id: k,
        kind: "hubspot.subscription",
        provider: "hubspot",
        agent: "crm",
        gate: "auto",
        summary: { eventId: input.eventId, subscription: input.marketingSubscriptionId, to: subscribed ? "SUBSCRIBED" : "NOT_SUBSCRIBED" },
        after: crm.contactId ? [`hubspot.consent:${crm.contactId}`] : [],
        async execute({ providers }) {
          const hs = providers.hubspot!;
          const want = subscribed ? "SUBSCRIBED" : "NOT_SUBSCRIBED";
          const now = (await hs.subscriptionStatuses(input.email)).find((s) => s.id === input.marketingSubscriptionId)?.status;
          if (now === want) throw new SkipAction(`already ${want}`);
          const r = await hs.setSubscription(input.email, input.marketingSubscriptionId, subscribed, `${input.source} ${input.eventId} at ${at}`);
          return { ref: r.id, detail: { status: r.status } };
        },
      });
    }
    for (const c of billing?.customers ?? []) {
      const k = `stripe.consent:${c.id}`;
      writes.push(k);
      actions.push({
        id: k,
        kind: "stripe.consent",
        provider: "stripe",
        agent: "billing",
        gate: "auto",
        summary: { eventId: input.eventId, customer: c.id, changes: input.changes },
        async execute({ providers }) {
          const cur = await providers.stripe!.getCustomer(c.id);
          const { patch, stale } = toWrite(stripeProps(cur));
          await providers.stripe!.updateCustomerMetadata(c.id, { ...patch, acme_consent_last_event: input.eventId });
          return { ref: c.id, detail: { wrote: Object.keys(patch), stale } };
        },
      });
    }

    const missing = [...(crm ? [] : ["HubSpot"]), ...(billing ? [] : ["Stripe"])];
    if (missing.length || !writes.length) {
      actions.push({
        id: "slack.post_consent",
        kind: "slack.post_consent",
        provider: "slack",
        agent: "crm",
        gate: "auto",
        summary: { eventId: input.eventId, missing },
        async execute({ providers }) {
          const text = missing.length
            ? `:warning: Consent ${input.eventId} (subject ${ref}) could not be applied in ${missing.join(" and ")}; it will be retried when this run is re-driven.`
            : `Consent ${input.eventId} (subject ${ref}): no record holds this address; nothing to change.`;
          return { ref: (await providers.slack!.postMessage(input.privacyChannel, text)).ts };
        },
      });
    }
    if (!writes.length) return actions;

    const verify = "consent.verify";
    actions.push({
      id: verify,
      kind: "consent.verify",
      provider: "hubspot",
      agent: "crm",
      gate: "auto",
      summary: { eventId: input.eventId, afterMinutes: VERIFY_AFTER_MS / 60_000, systems: writes.length },
      after: writes,
      delayAfter: { action: writes[0]!, ms: VERIFY_AFTER_MS },
      async execute({ providers, statuses }) {
        const mismatched: string[] = [];
        const reapplied: string[] = [];
        for (const w of writes) {
          if (statuses[w] === "failed") mismatched.push(`${w} (write failed)`);
        }
        if (crm?.contactId) {
          const cur = hubspotProps(await providers.hubspot!.get(crm.contactId, PURPOSES.map(prop)));
          const off = input.changes.filter((ch) => verdict(cur[ch.purpose], ch.state, at) === "write");
          if (off.length) {
            // Re-apply once (another integration may have overwritten it), then check again.
            await providers.hubspot!.update(crm.contactId, Object.fromEntries(off.map((ch) => [prop(ch.purpose), encode(ch.state, at)])));
            reapplied.push(`HubSpot ${crm.contactId}`);
            const again = hubspotProps(await providers.hubspot!.get(crm.contactId, PURPOSES.map(prop)));
            if (input.changes.some((ch) => verdict(again[ch.purpose], ch.state, at) === "write")) mismatched.push(`HubSpot ${crm.contactId}`);
          }
        }
        if (marketing && crm) {
          const want = marketing.state === "granted" ? "SUBSCRIBED" : "NOT_SUBSCRIBED";
          const now = (await providers.hubspot!.subscriptionStatuses(input.email)).find((s) => s.id === input.marketingSubscriptionId)?.status;
          if (now !== want) mismatched.push(`HubSpot subscription ${input.marketingSubscriptionId} is ${now ?? "unknown"}`);
        }
        for (const c of billing?.customers ?? []) {
          const cur = stripeProps(await providers.stripe!.getCustomer(c.id));
          if (input.changes.some((ch) => verdict(cur[ch.purpose], ch.state, at) === "write")) mismatched.push(`Stripe ${c.id}`);
        }
        if (mismatched.length) {
          await providers.slack!.postMessage(input.privacyChannel, `:rotating_light: Consent ${input.eventId} (subject ${ref}) is not in effect everywhere: ${mismatched.join("; ")}. Privacy-ops must fix this before the next send.`);
          return { ref: "mismatch", detail: { mismatched, reapplied } };
        }
        return { ref: "verified", detail: { reapplied } };
      },
    });
    return actions;
  },

  output({ input }, results) {
    const crm = out<Crm>(results, "crm");
    const billing = out<Billing>(results, "billing");
    return { mode: crm && billing ? "propagate" : "partial", contact: crm?.contactId ?? null, customers: billing?.customers.length ?? null, purposes: input.changes.map((c) => `${c.purpose}=${c.state}`) };
  },

  catalog: [
    { kind: "hubspot.consent", provider: "hubspot", gate: "auto", description: "Consent property per purpose, guarded by event time" },
    { kind: "hubspot.subscription", provider: "hubspot", gate: "auto", description: "Marketing email subscription on or off" },
    { kind: "stripe.consent", provider: "stripe", gate: "auto", description: "Consent metadata on every customer with the address" },
    { kind: "slack.post_consent", provider: "slack", gate: "auto", description: "A system could not be read, or nothing holds the address" },
    { kind: "consent.verify", provider: "hubspot", gate: "auto", description: "Read every system back after 15 minutes; re-apply once; escalate a mismatch" },
  ],
};
