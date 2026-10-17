import { z } from "zod";
import { ProviderError } from "../kit/errors";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import type { WorkOSClient, WorkOSUser } from "../providers/work";
import { Approvers, ChannelId, Email, messageId, out, shortHash } from "./shared";

// IT org · it-asset-mgmt team.
// Trigger: monthly schedule. Finds directory seats nobody uses, warns their
// owners, and (after a grace period, with approval) reclaims the seat.

const Input = z.object({
  organizationId: z.string().min(1).max(100).optional(),
  inactiveDays: z.number().int().min(14).max(365).default(90),
  graceDays: z.number().int().min(1).max(90).default(14),
  itChannel: ChannelId,
  /** Service accounts and exec assistants that must never be reclaimed. */
  excludeEmails: z.array(Email).max(500).default([]),
  maxReclaims: z.number().int().min(0).max(100).default(25),
  approvers: Approvers,
});
type Input = z.infer<typeof Input>;

interface Seat {
  userId: string;
  email: string;
  lastActive: string;
  idleDays: number;
  neverSignedIn: boolean;
}

/**
 * Every user in the directory. Pages until a page adds nothing new, so a
 * backend that keeps returning a cursor can't loop us forever.
 */
async function listDirectory(workos: WorkOSClient, organizationId: string | undefined): Promise<WorkOSUser[]> {
  const seen = new Map<string, WorkOSUser>();
  let after: string | undefined;
  for (let page = 0; page < 50; page++) {
    const { body } = await workos.http.request<any>("GET", "/user_management/users", { query: { limit: 100, after, organization_id: organizationId } });
    const users: WorkOSUser[] = body?.data ?? [];
    const before = seen.size;
    for (const u of users) seen.set(u.id, u);
    after = body?.list_metadata?.after ?? undefined;
    if (!after || seen.size === before) break;
  }
  return [...seen.values()];
}

export function classify(users: WorkOSUser[], now: Date, input: Pick<Input, "inactiveDays" | "graceDays" | "excludeEmails">) {
  const exclude = new Set(input.excludeEmails);
  const warn: Seat[] = [];
  const reclaim: Seat[] = [];
  for (const u of users) {
    const email = u.email?.toLowerCase();
    if (!email || exclude.has(email)) continue;
    const created = (u as { created_at?: string }).created_at;
    const lastActive = u.last_sign_in_at ?? created;
    if (!lastActive || !Number.isFinite(Date.parse(lastActive))) continue;
    const idleDays = Math.floor((now.getTime() - Date.parse(lastActive)) / 86_400_000);
    const seat = { userId: u.id, email, lastActive, idleDays, neverSignedIn: !u.last_sign_in_at };
    if (idleDays >= input.inactiveDays + input.graceDays) reclaim.push(seat);
    else if (idleDays >= input.inactiveDays) warn.push(seat);
  }
  const byIdle = (a: Seat, b: Seat) => b.idleDays - a.idleDays || a.userId.localeCompare(b.userId);
  return { warn: warn.sort(byIdle), reclaim: reclaim.sort(byIdle) };
}

export const licenseReclaim: WorkflowDef<Input> = {
  id: "license-reclaim",
  title: "SaaS license reclaim",
  org: "IT",
  team: "it-asset-mgmt",
  description:
    "Scan the directory for seats idle past the policy, warn their owners, and reclaim seats still idle after the grace period once IT approves; reconcile proves each reclaimed account is gone.",
  input: Input,
  agents: [
    {
      name: "directory-scan",
      needs: ["workos"],
      async run({ input, providers, startedAt }) {
        const users = await listDirectory(providers.workos!, input.organizationId);
        const { warn, reclaim } = classify(users, startedAt, input);
        return { summary: `${users.length} seats: ${warn.length} to warn, ${reclaim.length} to reclaim`, data: { total: users.length, warn, reclaim } };
      },
    },
  ],

  plan({ input }, results) {
    const scan = out<{ total: number; warn: Seat[]; reclaim: Seat[] }>(results, "directory-scan");
    if (!scan) return [];
    const reclaim = scan.reclaim.slice(0, input.maxReclaims);
    const actions: PlannedAction<Input>[] = [];
    if (scan.warn.length || reclaim.length) {
      actions.push({
        id: "slack.post_summary",
        kind: "slack.post_summary",
        provider: "slack",
        agent: "directory-scan",
        gate: "auto",
        summary: { channel: input.itChannel, warn: scan.warn.length, reclaim: reclaim.length },
        async execute({ providers }) {
          const text = [
            `*License reclaim* — ${scan.total} seats scanned: ${scan.warn.length} idle ≥${input.inactiveDays}d (warned), ${reclaim.length} idle ≥${input.inactiveDays + input.graceDays}d (reclaim awaiting approval).`,
            ...reclaim.slice(0, 15).map((s) => `• ${s.email} — ${s.neverSignedIn ? "never signed in" : `last active ${s.lastActive.slice(0, 10)}`} (${s.idleDays}d)`),
          ].join("\n");
          const m = await providers.slack!.postMessage(input.itChannel, text);
          return { ref: m.ts };
        },
      });
    }
    for (const s of scan.warn) {
      const key = shortHash(s.userId);
      actions.push({
        id: `gmail.draft_warning:${key}`,
        kind: "gmail.draft_warning",
        provider: "gmail",
        agent: "directory-scan",
        gate: "auto",
        summary: { to: s.email, idleDays: s.idleDays, sent: false },
        async execute({ providers, runId }) {
          const d = await providers.gmail!.createDraft({
            to: s.email,
            subject: "Your ACME account will be reclaimed unless you sign in",
            body: `Hi,\n\nYour ACME account hasn't been used for ${s.idleDays} days. If you still need it, sign in within ${input.graceDays} days; otherwise IT will reclaim the seat.\n\nACME IT`,
            messageId: messageId(runId, `warn-${key}`),
          });
          return { ref: d.id };
        },
      });
    }
    for (const s of reclaim) {
      actions.push({
        id: `workos.reclaim_seat:${shortHash(s.userId)}`,
        kind: "workos.reclaim_seat",
        provider: "workos",
        agent: "directory-scan",
        gate: "approval",
        summary: { email: s.email, userId: s.userId, idleDays: s.idleDays, neverSignedIn: s.neverSignedIn },
        async execute({ providers, startedAt }) {
          // The approval may come days later: re-check the seat is still idle on the
          // account's own record, never reclaim a seat that is in use again.
          const u = await providers.workos!.getUser(s.userId).catch((err) => {
            if (err instanceof ProviderError && err.status === 404) return undefined;
            throw err;
          });
          if (!u) return { ref: s.userId, detail: { alreadyGone: true } };
          const still = classify([u], new Date(Math.max(Date.now(), startedAt.getTime())), input).reclaim.length > 0;
          if (!still) return { ref: s.userId, detail: { skipped: "signed in since scan" } };
          await providers.workos!.deleteUser(s.userId);
          return { ref: s.userId, detail: { reclaimed: true } };
        },
        async reconcile({ providers }, r) {
          if (r.detail?.skipped) return { status: "unverifiable", detail: String(r.detail.skipped) };
          try {
            await providers.workos!.getUser(r.ref);
            return { status: "drift", detail: "account still exists" };
          } catch (err) {
            if (err instanceof ProviderError && err.status === 404) return { status: "match", detail: "seat reclaimed" };
            throw err;
          }
        },
      });
    }
    return actions;
  },

  output({ input }, results) {
    const scan = out<{ total: number; warn: Seat[]; reclaim: Seat[] }>(results, "directory-scan");
    return {
      scanned: scan?.total ?? 0,
      warned: scan?.warn.length ?? 0,
      reclaimable: scan?.reclaim.length ?? 0,
      proposed: Math.min(scan?.reclaim.length ?? 0, input.maxReclaims),
      directoryRead: !!scan,
    };
  },

  catalog: [
    { kind: "slack.post_summary", provider: "slack", gate: "auto", description: "Post the idle-seat summary to IT" },
    { kind: "gmail.draft_warning", provider: "gmail", gate: "auto", description: "Draft (not send) a sign-in-or-lose-it warning per idle user" },
    { kind: "workos.reclaim_seat", provider: "workos", gate: "approval", description: "Delete the directory account of a seat idle past the grace period" },
  ],
};
