import { z } from "zod";
import { FatalError } from "../kit/errors";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import { stripeTime } from "../providers/stripe";
import type { WorkOSMembership } from "../providers/work";
import { Approvers, ChannelId, Email, money, out, plain, shortHash } from "./shared";

// IT · it-security.
// Trigger: a suspected account takeover of a customer's user (from the SIEM or
// the identity provider's risk engine). Two stages:
//   "contain"  score the alert with identity and billing evidence, then hold
//              refunds, revoke sessions and remove privileged memberships,
//              never locking an organization out of its last admin automatically
//   "restore"  after the investigation, put back the memberships the record
//              lists and release this alert's hold, always with approval

export const POLICY = {
  /** Points per signal from the alert; the alert can't change them. */
  weights: { impossible_travel: 30, mfa_reset: 35, password_reset_via_support: 30, new_api_key: 20, mass_export: 35, new_device: 10, admin_role_granted: 40 } as Record<string, number>,
  /** Refunds to the account's Stripe customers in the last 24 h: this many, or this much, add `refundSpikePoints`. */
  refundSpike: { count: 3, amountMinor: 50_000, points: 25 },
  high: 70,
  medium: 40,
  /** Roles whose loss of control hurts the customer: removed on containment. */
  privileged: ["owner", "admin"],
  /** More privileged memberships than this in one alert are removed only with approval (blast radius). */
  autoRemoveMax: 5,
  /** Stripe metadata key other workflows check before moving money (e.g. cross-border-refund). */
  holdKey: "acme_ato_hold",
} as const;

const Signal = z.enum(["impossible_travel", "mfa_reset", "password_reset_via_support", "new_api_key", "mass_export", "new_device", "admin_role_granted"]);
const AlertId = z.string().regex(/^[\w.-]{3,64}$/, "alert id like SEC-2026-0042");
const Common = { alertId: AlertId, email: Email, securityChannel: ChannelId, securityWorkspace: z.string().min(1).default("acme-security"), approvers: Approvers };

const Contain = z.object({
  stage: z.literal("contain"),
  ...Common,
  signals: z.array(Signal).min(1).max(10),
  /** Where the alert came from, for the record only. */
  source: z.string().max(64).default("siem"),
});
const Restore = z.object({
  stage: z.literal("restore"),
  ...Common,
  /** Memberships to put back, from the containment record. */
  memberships: z
    .array(z.object({ organizationId: z.string().regex(/^[\w-]{3,64}$/), role: z.string().regex(/^[a-z][\w-]{1,40}$/) }))
    .max(20)
    .default([])
    .refine((ms) => new Set(ms.map((m) => m.organizationId)).size === ms.length, "an organization is listed twice"),
  releaseHold: z.boolean().default(true),
});
const Input = z.discriminatedUnion("stage", [Contain, Restore]);
type Input = z.infer<typeof Input>;

export interface Identity {
  userId: string | null;
  memberships: { id: string; organizationId: string; role: string; status: string; otherActiveAdmins: number }[];
  sessions: string[];
}
export interface Billing {
  customers: { id: string; hold: string | null }[];
  refunds24h: { count: number; amountMinor: number; currency: string };
}
export interface Assessment {
  mode: "contain" | "monitor" | "nothing" | "blocked" | "restore";
  reason: string;
  score: number;
  level: "high" | "medium" | "low";
  reasons: string[];
  removals: { membershipId: string; organizationId: string; role: string; gate: "auto" | "approval"; why: string }[];
  holds: string[];
  revokeSessions: boolean;
  restores: { organizationId: string; role: string }[];
  releases: string[];
}

/** Risk from the alert's signals and the account's own billing evidence. Pure. */
export function score(signals: string[], billing: Billing | undefined): { score: number; level: Assessment["level"]; reasons: string[] } {
  const reasons: string[] = [];
  let total = 0;
  for (const s of [...new Set(signals)]) {
    total += POLICY.weights[s] ?? 0;
    reasons.push(`${s} +${POLICY.weights[s] ?? 0}`);
  }
  const r = billing?.refunds24h;
  if (r && (r.count >= POLICY.refundSpike.count || r.amountMinor >= POLICY.refundSpike.amountMinor)) {
    total += POLICY.refundSpike.points;
    reasons.push(`refund spike (${r.count} refunds, ${money(r.amountMinor, r.currency)} in 24 h) +${POLICY.refundSpike.points}`);
  }
  return { score: total, level: total >= POLICY.high ? "high" : total >= POLICY.medium ? "medium" : "low", reasons };
}

const privileged = (role: string) => (POLICY.privileged as readonly string[]).includes(role);

/** What containment (or restore) does, from the alert and what the agents read. Pure. */
export function assess(input: Input, identity: Identity | undefined, billing: Billing | undefined): Assessment {
  const none = { removals: [], holds: [], revokeSessions: false, restores: [], releases: [] };
  if (input.stage === "restore") {
    if (!identity || !billing) return { ...none, mode: "blocked", reason: `${identity ? "billing" : "identity"} could not be read`, score: 0, level: "low", reasons: [] };
    if (!identity.userId) return { ...none, mode: "nothing", reason: "no such user", score: 0, level: "low", reasons: [] };
    const present = new Set(identity.memberships.map((m) => m.organizationId));
    return {
      ...none,
      mode: "restore",
      reason: "restore after investigation",
      score: 0,
      level: "low",
      reasons: [],
      restores: input.memberships.filter((m) => !present.has(m.organizationId)),
      // Only this alert's hold: another investigation's hold stays.
      releases: input.releaseHold ? billing.customers.filter((c) => c.hold === input.alertId).map((c) => c.id) : [],
    };
  }

  const s = score(input.signals, billing);
  const base = { ...none, score: s.score, level: s.level, reasons: billing ? s.reasons : [...s.reasons, "billing unread: no refund evidence, no hold"] };
  if (s.level === "low") return { ...base, mode: "monitor", reason: `score ${s.score} below ${POLICY.medium}` };
  // Containment acts on what it has read; without the directory nothing is removed blindly.
  if (!identity) return { ...base, mode: "blocked", reason: "identity directory could not be read; contain by hand" };
  const holds = (billing?.customers ?? []).filter((c) => c.hold !== input.alertId).map((c) => c.id);
  const targets = identity.memberships.filter((m) => privileged(m.role) && m.status !== "inactive");
  let auto = 0;
  const removals = targets.map((m) => {
    const r = { membershipId: m.id, organizationId: m.organizationId, role: m.role };
    if (s.level !== "high") return { ...r, gate: "approval" as const, why: `risk ${s.level}` };
    if (m.otherActiveAdmins === 0) return { ...r, gate: "approval" as const, why: "last admin of the organization" };
    if (auto >= POLICY.autoRemoveMax) return { ...r, gate: "approval" as const, why: `more than ${POLICY.autoRemoveMax} memberships` };
    auto++;
    return { ...r, gate: "auto" as const, why: "high risk" };
  });
  const revokeSessions = !!identity.userId && identity.sessions.length > 0;
  if (!removals.length && !holds.length && !revokeSessions) return { ...base, mode: "nothing", reason: identity.userId ? "already contained" : "no such user and no billing account" };
  return { ...base, mode: "contain", reason: `${s.level} risk (score ${s.score})`, removals, holds, revokeSessions };
}

const memberSummary = (m: WorkOSMembership) => ({ id: m.id, organizationId: m.organization_id, role: m.role?.slug ?? "", status: m.status });

export const accountTakeoverContainment: WorkflowDef<Input> = {
  id: "account-takeover-containment",
  title: "Account takeover containment",
  org: "IT",
  team: "it-security",
  description:
    "Score a suspected account takeover from the alert's signals and refund activity, then hold the account's Stripe refunds, revoke sessions and remove privileged WorkOS memberships, never the org's last admin without approval. Restore puts memberships back with approval.",
  input: Input,
  agents: [
    {
      name: "identity",
      needs: ["workos"],
      async run({ input, providers }) {
        const wo = providers.workos!;
        const user = await wo.findUserByEmail(input.email);
        if (!user) return { summary: "no WorkOS user", data: { userId: null, memberships: [], sessions: [] } satisfies Identity };
        const mine = (await wo.listMemberships(user.id)).map(memberSummary);
        const memberships: Identity["memberships"] = [];
        for (const m of mine) {
          // Who else could administer the organization if this membership goes.
          const others = privileged(m.role) ? (await wo.listOrganizationMemberships(m.organizationId)).filter((o) => o.user_id !== user.id && o.status === "active" && privileged(o.role?.slug ?? "")).length : 0;
          memberships.push({ ...m, otherActiveAdmins: others });
        }
        const sessions = input.stage === "contain" ? (await wo.listSessions(user.id)).map((x) => x.id) : [];
        const data: Identity = { userId: user.id, memberships, sessions };
        return { summary: `${memberships.length} membership(s), ${memberships.filter((m) => privileged(m.role)).length} privileged, ${sessions.length} session(s)`, data };
      },
    },
    {
      name: "billing",
      needs: ["stripe"],
      async run({ input, providers, startedAt }) {
        const stripe = providers.stripe!;
        const customers = await stripe.findCustomersByEmail(input.email);
        const since = startedAt.getTime() - 86_400_000;
        let count = 0;
        let amountMinor = 0;
        let currency = "usd";
        for (const c of customers) {
          const recent = (await stripe.listPaymentIntents(c.id)).filter((p) => (stripeTime(p.created) ?? 0) >= since - 30 * 86_400_000);
          for (const p of recent) {
            for (const r of await stripe.listRefundsForPaymentIntent(p.id)) {
              if (r.status === "failed" || r.status === "canceled") continue;
              const at = stripeTime((r as { created?: number | string }).created);
              if (at === undefined || at < since) continue;
              count++;
              amountMinor += r.amount;
              currency = r.currency;
            }
          }
        }
        const data: Billing = { customers: customers.map((c) => ({ id: c.id, hold: c.metadata?.[POLICY.holdKey] || null })), refunds24h: { count, amountMinor, currency } };
        return { summary: `${customers.length} Stripe customer(s), ${count} refund(s) in 24 h`, data };
      },
    },
  ],

  compose: {
    name: "assessment",
    async run({ input }, results) {
      const a = assess(input, out<Identity>(results, "identity"), out<Billing>(results, "billing"));
      return { summary: `${a.mode}: ${a.reason}`, data: a };
    },
  },

  plan({ input, startedAt }, results) {
    const a = out<Assessment>(results, "assessment");
    const identity = out<Identity>(results, "identity");
    if (!a) return [];
    const actions: PlannedAction<Input>[] = [];
    const who = shortHash("user", input.email).slice(0, 10);

    for (const cus of a.holds) {
      actions.push({
        id: `stripe.hold_customer:${cus}`,
        kind: "stripe.hold_customer",
        provider: "stripe",
        agent: "assessment",
        gate: "auto",
        summary: { customer: cus, alert: input.alertId },
        async execute({ providers }) {
          const c = await providers.stripe!.updateCustomerMetadata(cus, { [POLICY.holdKey]: input.alertId, acme_ato_hold_at: startedAt.toISOString() });
          return { ref: c.id };
        },
        async reconcile({ providers }) {
          const c = await providers.stripe!.getCustomer(cus);
          return c.metadata?.[POLICY.holdKey] === input.alertId ? { status: "match" } : { status: "drift", detail: `hold is ${c.metadata?.[POLICY.holdKey] || "released"}` };
        },
      });
    }

    if (a.revokeSessions && identity?.userId) {
      const userId = identity.userId;
      actions.push({
        id: "workos.revoke_sessions",
        kind: "workos.revoke_sessions",
        provider: "workos",
        agent: "assessment",
        gate: "auto",
        summary: { user: who, sessions: identity.sessions.length },
        async execute({ providers }) {
          // Re-list at write time: sessions opened since the scan are revoked too.
          const live = await providers.workos!.listSessions(userId);
          for (const s of live) await providers.workos!.revokeSession(s.id);
          return { ref: userId, detail: { revoked: live.length } };
        },
      });
    }

    for (const r of a.removals) {
      actions.push({
        id: `workos.remove_membership:${r.membershipId}`,
        kind: "workos.remove_membership",
        provider: "workos",
        agent: "assessment",
        gate: r.gate,
        summary: { user: who, organization: r.organizationId, role: r.role, why: r.why },
        async execute({ providers }) {
          const wo = providers.workos!;
          const cur = (await wo.listMemberships(identity!.userId!)).find((m) => m.id === r.membershipId);
          if (!cur) return { ref: r.membershipId, detail: { alreadyRemoved: true } };
          if (r.gate === "auto") {
            // An automatic removal must not become the one that locks the organization out.
            const others = (await wo.listOrganizationMemberships(r.organizationId)).filter((o) => o.user_id !== identity!.userId && o.status === "active" && privileged(o.role?.slug ?? ""));
            if (!others.length) throw new FatalError(`${r.organizationId} would have no admin left`);
          }
          await wo.deleteMembership(r.membershipId);
          return { ref: r.membershipId, detail: { organizationId: r.organizationId, role: r.role } };
        },
        async reconcile({ providers }) {
          const still = (await providers.workos!.listMemberships(identity!.userId!)).some((m) => m.id === r.membershipId);
          return still ? { status: "drift", detail: "membership is back" } : { status: "match" };
        },
      });
    }

    for (const m of a.restores) {
      actions.push({
        id: `workos.restore_membership:${m.organizationId}`,
        kind: "workos.restore_membership",
        provider: "workos",
        agent: "assessment",
        gate: "approval",
        summary: { user: who, organization: m.organizationId, role: m.role },
        async execute({ providers }) {
          const wo = providers.workos!;
          const existing = (await wo.listMemberships(identity!.userId!)).find((x) => x.organization_id === m.organizationId);
          if (existing) return { ref: existing.id, detail: { reused: true, role: existing.role?.slug } };
          const created = await wo.createMembership(identity!.userId!, m.organizationId, m.role);
          return { ref: created.id, detail: { role: m.role } };
        },
      });
    }

    for (const cus of a.releases) {
      actions.push({
        id: `stripe.release_hold:${cus}`,
        kind: "stripe.release_hold",
        provider: "stripe",
        agent: "assessment",
        gate: "approval",
        summary: { customer: cus, alert: input.alertId },
        async execute({ providers }) {
          const stripe = providers.stripe!;
          const c = await stripe.getCustomer(cus);
          // Another alert may have placed its own hold since: leave it.
          if (c.metadata?.[POLICY.holdKey] !== input.alertId) return { ref: cus, detail: { skipped: c.metadata?.[POLICY.holdKey] ? "held by another alert" : "already released" } };
          await stripe.updateCustomerMetadata(cus, { [POLICY.holdKey]: "", acme_ato_hold_at: "" });
          return { ref: cus };
        },
      });
    }

    const removed = a.removals.map((r) => `- ${r.organizationId} ${r.role} (${r.membershipId}) ${r.gate}: ${r.why}`);
    const lines = [
      `Alert ${input.alertId} for user ${who}${input.stage === "contain" ? ` from ${plain(input.source, 64)}: ${input.signals.join(", ")}` : ""}.`,
      `Decision: ${a.mode} (${a.reason}).`,
      ...(input.stage === "contain" ? [`Score ${a.score} (${a.level}): ${a.reasons.join("; ")}.`] : []),
      a.holds.length ? `Stripe refund hold on ${a.holds.join(", ")}.` : "",
      a.revokeSessions ? `Sessions revoked: ${identity?.sessions.length ?? 0} at scan time.` : "",
      removed.length ? "Privileged memberships removed (restore input):" : "",
      ...removed,
      removed.length ? `Restore with {"stage":"restore","alertId":"${input.alertId}","memberships":${JSON.stringify(a.removals.map((r) => ({ organizationId: r.organizationId, role: r.role })))}}` : "",
      ...a.restores.map((m) => `- restore ${m.organizationId} as ${m.role} (approval)`),
      a.releases.length ? `Release hold on ${a.releases.join(", ")} (approval).` : "",
    ].filter(Boolean);
    if (a.mode !== "monitor" && a.mode !== "nothing") {
      actions.push({
        id: "asana.incident_record",
        kind: "asana.incident_record",
        provider: "asana",
        agent: "assessment",
        gate: "auto",
        summary: { alert: input.alertId, mode: a.mode },
        async execute({ providers }) {
          const t = await providers.asana!.createTask({ name: `${input.alertId}: account takeover ${input.stage} (${a.mode})`, notes: lines.join("\n"), workspace: input.securityWorkspace });
          return { ref: t.gid };
        },
      });
    }

    const icon = a.mode === "contain" ? ":lock:" : a.mode === "restore" ? ":unlock:" : a.mode === "blocked" ? ":rotating_light:" : ":eyes:";
    const parked = a.removals.filter((r) => r.gate === "approval").length + a.restores.length + a.releases.length;
    const text = `${icon} ${input.alertId} (${input.stage}): ${a.mode}, ${a.reason}.${a.removals.length ? ` ${a.removals.length} privileged membership(s).` : ""}${a.holds.length ? ` Refunds held.` : ""}${parked ? ` ${parked} change(s) need approval.` : ""}`;
    actions.push({
      id: "slack.post_alert",
      kind: "slack.post_alert",
      provider: "slack",
      agent: "assessment",
      gate: "auto",
      summary: { channel: input.securityChannel, mode: a.mode },
      async execute({ providers }) {
        const msg = await providers.slack!.postMessage(input.securityChannel, text);
        return { ref: msg.ts, detail: { channel: msg.channel } };
      },
    });
    return actions;
  },

  output(_ctx, results) {
    const a = out<Assessment>(results, "assessment");
    if (!a) return { mode: "not decided" };
    return { mode: a.mode, reason: a.reason, score: a.score, level: a.level, removals: a.removals.length, removalsAuto: a.removals.filter((r) => r.gate === "auto").length, holds: a.holds.length, revokeSessions: a.revokeSessions, restores: a.restores.length, releases: a.releases.length };
  },

  catalog: [
    { kind: "stripe.hold_customer", provider: "stripe", gate: "auto", description: "Mark the account's Stripe customers so refund workflows stop moving money" },
    { kind: "workos.revoke_sessions", provider: "workos", gate: "auto", description: "Revoke the user's sessions (re-listed at write time)" },
    { kind: "workos.remove_membership", provider: "workos", gate: "auto", description: "Remove a privileged membership; approval at medium risk, for an org's last admin, or past the per-alert limit" },
    { kind: "workos.restore_membership", provider: "workos", gate: "approval", description: "Put back a membership from the containment record" },
    { kind: "stripe.release_hold", provider: "stripe", gate: "approval", description: "Release this alert's refund hold" },
    { kind: "asana.incident_record", provider: "asana", gate: "auto", description: "Incident record with the score, actions and restore input" },
    { kind: "slack.post_alert", provider: "slack", gate: "auto", description: "Decision in the security channel" },
  ],
};

