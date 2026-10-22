import { z } from "zod";
import { SkipAction } from "../kit/errors";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import { Approvers, ChannelId, out, shortHash } from "./shared";

// IT Security · grc.
// Trigger: the quarterly SOC 2 / SOX user access review. A campaign pulls
// every entitlement from the in-scope systems (WorkOS organizations, the
// GitHub organization), assigns each to its system owner, and waits for one
// decision per entitlement (Kit v2 signals): keep or revoke. Nobody certifies
// their own access. Reviewers get reminders on day 7 and day 12 for what they
// still owe. At the deadline, unreviewed privileged access is revoked and
// unreviewed standard access is kept but reported as an exception. Revocations
// are executed and verified, and the campaign closes with an evidence record
// carrying the audit trail's head hash.

export const POLICY = {
  campaignDays: 14,
  reminderDays: [7, 12],
  privilegedRoles: ["owner", "admin"],
  /** One campaign run reviews at most this many entitlements; larger scopes are split per system. */
  maxEntitlements: 500,
  /** Users who haven't signed in for this long are recommended for revocation. */
  dormantDays: 90,
} as const;

const Reviewer = z.object({ userId: z.string().min(1), email: z.string().email() });
const Input = z.object({
  campaignId: z.string().regex(/^UAR-[\w-]{3,40}$/, "campaign id like UAR-2026-Q4"),
  scope: z.object({
    workosOrganizations: z.array(z.string().regex(/^[\w-]{3,64}$/)).max(20).default([]),
    githubOrg: z.string().regex(/^[\w-]{1,39}$/).optional(),
  }),
  /** Who reviews each system's access. */
  owners: z.object({ workos: Reviewer.optional(), github: Reviewer.optional() }),
  /** Maps GitHub logins to the employee's email, so self-review is caught across systems. */
  githubEmails: z.record(z.string(), z.string().email()).default({}),
  grcChannel: ChannelId,
  grcWorkspace: z.string().min(1).default("acme-grc"),
  approvers: Approvers,
});
type Input = z.infer<typeof Input>;

export interface Entitlement {
  id: string;
  system: "workos" | "github";
  /** Organization or GitHub org. */
  resource: string;
  role: string;
  holderEmail: string | null;
  holderRef: string;
  privileged: boolean;
  dormant: boolean;
}
export interface Campaign {
  mode: "review" | "blocked" | "too_large";
  reason: string;
  items: (Entitlement & { reviewer: { userId: string; email: string } | null; selfReview: boolean })[];
  unowned: number;
}

const DAY = 86_400_000;

/** Reviewer assignment. Pure. */
export function buildCampaign(input: Input, entitlements: Entitlement[] | undefined, failed: string[]): Campaign {
  if (!entitlements) return { mode: "blocked", reason: `entitlements could not be read from ${failed.join(", ") || "any system"}`, items: [], unowned: 0 };
  // A partial pull would certify an incomplete picture: refuse it.
  if (failed.length) return { mode: "blocked", reason: `entitlements could not be read from ${failed.join(", ")}; the campaign needs every in-scope system`, items: [], unowned: 0 };
  if (entitlements.length > POLICY.maxEntitlements) return { mode: "too_large", reason: `${entitlements.length} entitlements; split the scope (max ${POLICY.maxEntitlements} per campaign run)`, items: [], unowned: 0 };
  const items = entitlements.map((e) => {
    const reviewer = input.owners[e.system] ?? null;
    return { ...e, reviewer, selfReview: !!reviewer && !!e.holderEmail && reviewer.email.toLowerCase() === e.holderEmail.toLowerCase() };
  });
  return { mode: "review", reason: `${items.length} entitlement(s)`, items, unowned: items.filter((i) => !i.reviewer).length };
}

export const revokeId = (e: Pick<Entitlement, "id">) => `revoke:${e.id}`;

export const userAccessReview: WorkflowDef<Input> = {
  id: "user-access-review",
  title: "User access review",
  org: "IT Security",
  team: "grc",
  description:
    "Quarterly SOC 2 access certification: pull every entitlement from WorkOS and GitHub, one keep/revoke decision per entitlement from its system owner (never self-review), reminders, deadline defaults (privileged revoked), verified revocations and a hash-chained evidence record.",
  input: Input,
  audit: true,
  tickEvery: "rate(1 hour)",
  agents: [
    {
      name: "workos-entitlements",
      needs: ["workos"],
      async run({ input, providers, startedAt, checkpoint }) {
        const wo = providers.workos!;
        // Checkpointed per organization: a restart resumes after the last finished one.
        const done = (await checkpoint.load<Record<string, Entitlement[]>>("orgs")) ?? {};
        for (const org of input.scope.workosOrganizations) {
          if (done[org]) continue;
          const members = await wo.listOrganizationMemberships(org);
          const rows: Entitlement[] = [];
          for (const m of members.filter((x) => x.status !== "inactive")) {
            const u = await wo.getUser(m.user_id).catch(() => undefined);
            const last = u?.last_sign_in_at ? Date.parse(u.last_sign_in_at) : null;
            const role = m.role?.slug ?? "member";
            rows.push({ id: `workos:${m.id}`, system: "workos", resource: org, role, holderEmail: u?.email ?? null, holderRef: m.id, privileged: (POLICY.privilegedRoles as readonly string[]).includes(role), dormant: last !== null && startedAt.getTime() - last > POLICY.dormantDays * DAY });
          }
          done[org] = rows;
          await checkpoint.save("orgs", done);
        }
        const all = Object.values(done).flat();
        return { summary: `${all.length} WorkOS membership(s) in ${input.scope.workosOrganizations.length} organization(s)`, data: all };
      },
    },
    {
      name: "github-entitlements",
      needs: ["github"],
      async run({ input, providers }) {
        if (!input.scope.githubOrg) return { summary: "no GitHub org in scope", data: [] as Entitlement[] };
        const gh = providers.github!;
        const org = input.scope.githubOrg;
        const admins = await gh.listOrgMembers(org, "admin");
        const members = await gh.listOrgMembers(org, "member");
        const rows: Entitlement[] = [...admins.map((m) => ({ m, role: "admin" })), ...members.map((m) => ({ m, role: "member" }))].map(({ m, role }) => ({ id: `github:${org}:${m.login}`, system: "github", resource: org, role, holderEmail: input.githubEmails[m.login] ?? null, holderRef: m.login, privileged: role === "admin", dormant: false }));
        return { summary: `${rows.length} GitHub member(s) of ${org}`, data: rows };
      },
    },
  ],

  compose: {
    name: "campaign",
    async run({ input }, results) {
      const wanted = [input.scope.workosOrganizations.length ? "workos-entitlements" : null, input.scope.githubOrg ? "github-entitlements" : null].filter((x): x is string => !!x);
      const failed = wanted.filter((a) => results.status[a] !== "ok");
      const ents = wanted.flatMap((a) => (results.ok[a] as Entitlement[] | undefined) ?? []);
      const c = buildCampaign(input, wanted.length ? ents : undefined, failed);
      return { summary: `${c.mode}: ${c.reason}`, data: c };
    },
  },

  plan({ input, startedAt }, results) {
    const c = out<Campaign>(results, "campaign");
    if (!c) return [];
    const at = (days: number) => new Date(startedAt.getTime() + days * DAY).toISOString();
    const deadline = at(POLICY.campaignDays);
    const actions: PlannedAction<Input>[] = [];
    const reviewIds = c.items.map(revokeId);

    for (const e of c.items) {
      actions.push({
        id: revokeId(e),
        kind: "access.decide_and_revoke",
        provider: e.system,
        agent: "campaign",
        gate: "auto",
        // approve = revoke this access, reject = keep it.
        summary: { system: e.system, resource: e.resource, role: e.role, holder: e.holderEmail ? shortHash(e.holderEmail).slice(0, 10) : e.holderRef, privileged: e.privileged, dormant: e.dormant, reviewer: e.reviewer?.userId ?? "unowned", meaning: "approve = revoke, reject = keep" },
        awaitSignal: {
          // Unowned access is decided by GRC approvers.
          from: e.reviewer ? [e.reviewer.userId, ...(input.approvers ?? [])] : (input.approvers ?? []),
          notFrom: e.selfReview && e.reviewer ? [e.reviewer.userId] : [],
          deadline,
          onDeadline: e.privileged ? "approve" : "reject",
        },
        async execute({ providers, signal }) {
          if (e.system === "workos") {
            const wo = providers.workos!;
            const still = await wo.getMembership(e.holderRef).catch(() => undefined);
            if (!still) return { ref: e.holderRef, detail: { alreadyGone: true, decidedBy: signal?.by } };
            await wo.deleteMembership(e.holderRef);
          } else {
            const gh = providers.github!;
            if (!(await gh.getOrgMembership(e.resource, e.holderRef))) return { ref: e.holderRef, detail: { alreadyGone: true, decidedBy: signal?.by } };
            await gh.removeOrgMember(e.resource, e.holderRef);
          }
          return { ref: e.holderRef, detail: { decidedBy: signal?.by, defaulted: !!signal?.defaulted } };
        },
        async reconcile({ providers }) {
          if (e.system === "workos") return (await providers.workos!.getMembership(e.holderRef).catch(() => undefined)) ? { status: "drift", detail: "membership is back" } : { status: "match" };
          return (await providers.github!.getOrgMembership(e.resource, e.holderRef)) ? { status: "drift", detail: "member is back" } : { status: "match" };
        },
      });
    }

    // Reminders for whoever still owes decisions.
    const reviewers = [...new Map(c.items.filter((i) => i.reviewer).map((i) => [i.reviewer!.userId, i.reviewer!])).values()];
    for (const r of reviewers) {
      const mine = c.items.filter((i) => i.reviewer?.userId === r.userId).map(revokeId);
      for (const d of POLICY.reminderDays) {
        actions.push({
          id: `slack.remind:${r.userId}:d${d}`,
          kind: "slack.remind",
          provider: "slack",
          agent: "campaign",
          gate: "auto",
          summary: { reviewer: r.userId, day: d },
          waitUntil: at(d),
          async execute({ providers, statuses }) {
            const open = mine.filter((id) => statuses[id] === "awaiting_signal").length;
            if (!open) throw new SkipAction("nothing left to review");
            const m = await providers.slack!.postMessage(r.userId, `:clipboard: ${input.campaignId}: you have ${open} access decision(s) left; due ${deadline.slice(0, 10)}. Unreviewed admin access is revoked at the deadline.`);
            return { ref: m.ts, detail: { open } };
          },
        });
      }
    }

    const opening = `${input.campaignId}: ${c.mode} (${c.reason}); ${c.items.filter((i) => i.privileged).length} privileged, ${c.items.filter((i) => i.dormant).length} dormant, ${c.unowned} without an owner, ${c.items.filter((i) => i.selfReview).length} that the owner can't self-review. Due ${deadline.slice(0, 10)}.`;
    actions.push({
      id: "slack.campaign_opened",
      kind: "slack.campaign_opened",
      provider: "slack",
      agent: "campaign",
      gate: "auto",
      summary: { channel: input.grcChannel, mode: c.mode },
      async execute({ providers }) {
        const m = await providers.slack!.postMessage(input.grcChannel, `${c.mode === "review" ? ":clipboard:" : ":rotating_light:"} ${opening}`);
        return { ref: m.ts };
      },
    });

    if (c.mode === "review") {
      actions.push({
        id: "asana.evidence_record",
        kind: "asana.evidence_record",
        provider: "asana",
        agent: "campaign",
        gate: "auto",
        summary: { campaign: input.campaignId },
        after: reviewIds,
        async execute({ providers, statuses, runId }) {
          const count = (s: string) => reviewIds.filter((id) => statuses[id] === s).length;
          const revoked = count("applied");
          const kept = count("rejected");
          const failed = count("failed");
          const notes = [
            opening,
            `Closed: ${revoked} revoked, ${kept} kept, ${failed} revocation(s) failed.`,
            `Per-decision evidence (who, when, default or not) is the run's hash-chained audit trail: run ${runId}, {action:"evidence"}.`,
          ];
          const t = await providers.asana!.createTask({ name: `${input.campaignId}: access review evidence`, notes: notes.join("\n"), workspace: input.grcWorkspace });
          return { ref: t.gid, detail: { revoked, kept, failed } };
        },
      });
    }
    return actions;
  },

  output(_ctx, results) {
    const c = out<Campaign>(results, "campaign");
    if (!c) return { mode: "not decided" };
    return { mode: c.mode, reason: c.reason, entitlements: c.items.length, privileged: c.items.filter((i) => i.privileged).length, dormant: c.items.filter((i) => i.dormant).length, unowned: c.unowned, selfReview: c.items.filter((i) => i.selfReview).length };
  },

  catalog: [
    { kind: "access.decide_and_revoke", provider: "workos", gate: "auto", description: "Signal per entitlement from its owner (approve = revoke, reject = keep); deadline default: privileged revoked, standard kept" },
    { kind: "slack.remind", provider: "slack", gate: "auto", description: "Day 7 and 12 reminders to reviewers with open decisions" },
    { kind: "slack.campaign_opened", provider: "slack", gate: "auto", description: "Campaign scope posted to GRC" },
    { kind: "asana.evidence_record", provider: "asana", gate: "auto", description: "Closing evidence record once every decision is settled" },
  ],
};
