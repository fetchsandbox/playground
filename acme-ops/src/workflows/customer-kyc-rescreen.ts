import { z } from "zod";
import { SkipAction } from "../kit/errors";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import type { StripeConnectedAccount } from "../providers/stripe";
import { ChannelId, out, shortHash } from "./shared";

// Compliance · financial-crimes.
// Trigger: the periodic sanctions re-screen of a platform's connected accounts
// (Stripe Connect partners). Every account in the program is screened against
// the Consolidated Screening List. For each potential match:
//   - a strong match (score ≥ 95) holds payouts at once, as a precaution;
//   - a compliance analyst decides (signal): approve = true match, reject =
//     false positive; reminders every 3 days until decided;
//   - a false positive is recorded on the account (cleared for this exact hit
//     set for 180 days, so the next sweep doesn't re-raise it) and any
//     precautionary hold is released, restoring the previous schedule;
//   - a true match holds payouts (if not already) and goes to the MLRO, who
//     isn't the analyst, for the suspicious-activity-report decision, due 30
//     days from detection.
// A screening service that can't be reached screens nothing and says so.

export const POLICY = { reviewScore: 85, holdScore: 95, clearanceDays: 180, remindEveryDays: 3, sarDays: 30, maxAccounts: 2000 } as const;
const DAY = 86_400_000;

const Input = z.object({
  rescreenId: z.string().regex(/^KYC-[\w-]{3,40}$/, "re-screen id like KYC-2026-10-22"),
  /** Connected accounts with metadata.acme_program equal to this are in scope. */
  program: z.string().regex(/^[\w-]{2,60}$/),
  complianceChannel: ChannelId,
  analysts: z.array(z.string()).min(1),
  mlro: z.array(z.string()).min(1),
});
type Input = z.infer<typeof Input>;

export interface Hit {
  name: string;
  source: string;
  score: number;
}
export interface Screened {
  account: string;
  name: string;
  country: string | null;
  hits: Hit[];
  hitsKey: string;
  cleared: boolean;
  interval: string;
}

export const displayName = (a: StripeConnectedAccount) => a.business_profile?.name || a.company?.name || [a.individual?.first_name, a.individual?.last_name].filter(Boolean).join(" ") || a.id;
/** Stable key for a set of hits, so a clearance covers exactly what the analyst saw. */
export const hitsKey = (hits: Hit[]) => shortHash("kyc", ...hits.map((h) => `${h.source}:${h.name}`).sort()).slice(0, 16);
/** Clearance stored as "<hitsKey>@<expiry ISO>". */
export const isCleared = (stored: string | undefined, key: string, now: number) => {
  const [k, until] = (stored ?? "").split("@");
  return k === key && !!until && Date.parse(until) > now;
};

export const customerKycRescreen: WorkflowDef<Input> = {
  id: "customer-kyc-rescreen",
  title: "Partner sanctions re-screen",
  org: "Compliance",
  team: "financial-crimes",
  description:
    "Re-screen every connected account in a program against the sanctions lists; hold payouts at once on strong matches, have an analyst decide each match, record false positives so they aren't re-raised, release precautionary holds, and route true matches to the MLRO for the SAR decision within 30 days of detection.",
  input: Input,
  audit: true,
  tickEvery: "rate(1 hour)",
  agents: [
    {
      name: "screening",
      needs: ["stripe", "screening"],
      async run({ input, providers, checkpoint, startedAt }) {
        const accounts = (await providers.stripe!.listAccounts(POLICY.maxAccounts)).filter((a) => a.metadata?.acme_program === input.program);
        const done = (await checkpoint.load<Record<string, Screened>>("screened")) ?? {};
        for (const a of accounts) {
          if (done[a.id]) continue;
          const name = displayName(a);
          const hits = (await providers.screening!.search(name, a.country ?? undefined)).filter((h) => (h.score ?? 100) >= POLICY.reviewScore).map((h) => ({ name: h.name, source: h.source, score: h.score ?? 100 }));
          const key = hitsKey(hits);
          done[a.id] = { account: a.id, name, country: a.country ?? null, hits, hitsKey: key, cleared: hits.length > 0 && isCleared(a.metadata?.acme_kyc_cleared, key, startedAt.getTime()), interval: a.settings?.payouts?.schedule?.interval ?? "daily" };
          if (Object.keys(done).length % 25 === 0) await checkpoint.save("screened", done);
        }
        await checkpoint.save("screened", done);
        const all = Object.values(done);
        return { summary: `${all.length} account(s) screened, ${all.filter((s) => s.hits.length && !s.cleared).length} to review`, data: all };
      },
    },
  ],

  plan({ input, startedAt }, results) {
    const screened = out<Screened[]>(results, "screening");
    const post = (text: string): PlannedAction<Input> => ({
      id: "slack.post_rescreen",
      kind: "slack.post_rescreen",
      provider: "slack",
      agent: "screening",
      gate: "auto",
      summary: { rescreenId: input.rescreenId },
      async execute({ providers }) {
        return { ref: (await providers.slack!.postMessage(input.complianceChannel, text)).ts };
      },
    });
    if (!screened) return [post(`:warning: ${input.rescreenId}: ${input.program} could not be screened (accounts or screening list unreachable). No account has been re-screened.`)];
    const now = startedAt.getTime();
    const sarDue = new Date(now + POLICY.sarDays * DAY).toISOString();
    const actions: PlannedAction<Input>[] = [];
    const toReview = screened.filter((s) => s.hits.length && !s.cleared);
    for (const s of toReview) {
      const strong = s.hits.some((h) => h.score >= POLICY.holdScore);
      const hold = `stripe.precautionary_hold:${s.account}`;
      const review = `compliance.review:${s.account}`;
      if (strong) {
        actions.push({
          id: hold,
          kind: "stripe.precautionary_hold",
          provider: "stripe",
          agent: "screening",
          gate: "auto",
          summary: { account: s.account, topScore: Math.max(...s.hits.map((h) => h.score)) },
          async execute({ providers }) {
            const a = await providers.stripe!.getConnectedAccount(s.account);
            const was = a.settings?.payouts?.schedule?.interval ?? s.interval;
            if (was === "manual") throw new SkipAction("payouts already manual");
            await providers.stripe!.setPayoutSchedule(s.account, "manual");
            return { ref: s.account, detail: { was } };
          },
        });
      }
      actions.push({
        id: review,
        kind: "compliance.review",
        provider: "stripe",
        agent: "screening",
        gate: "auto",
        summary: { account: s.account, name: s.name, country: s.country, hits: s.hits, meaning: "approve = true match, reject = false positive" },
        awaitSignal: { from: input.analysts },
        ...(strong ? { after: [hold] } : {}),
        async execute({ providers, signal, applied }) {
          // True match: payouts stay (or go) on hold.
          if (!applied[hold]) {
            const a = await providers.stripe!.getConnectedAccount(s.account);
            if (a.settings?.payouts?.schedule?.interval !== "manual") await providers.stripe!.setPayoutSchedule(s.account, "manual");
          }
          await providers.stripe!.updateAccountMetadata(s.account, { acme_kyc_status: "true_match", acme_kyc_reviewed_by: signal!.by });
          return { ref: s.account, detail: { by: signal!.by } };
        },
      });
      actions.push({
        id: `stripe.clear:${s.account}`,
        kind: "stripe.clear",
        provider: "stripe",
        agent: "screening",
        gate: "auto",
        summary: { account: s.account, days: POLICY.clearanceDays },
        after: [review],
        async execute({ providers, statuses, applied }) {
          if (statuses[review] !== "rejected") throw new SkipAction(`review is ${statuses[review]}`);
          const until = new Date(Date.now() + POLICY.clearanceDays * DAY).toISOString();
          await providers.stripe!.updateAccountMetadata(s.account, { acme_kyc_cleared: `${s.hitsKey}@${until}`, acme_kyc_status: "cleared" });
          const was = applied[hold]?.detail?.was as string | undefined;
          if (was) await providers.stripe!.setPayoutSchedule(s.account, was);
          return { ref: s.account, detail: { released: !!was, until } };
        },
      });
      actions.push({
        id: `mlro.sar_decision:${s.account}`,
        kind: "mlro.sar_decision",
        provider: "slack",
        agent: "screening",
        gate: "auto",
        summary: { account: s.account, due: sarDue.slice(0, 10), meaning: "approve = file a SAR, reject = no SAR (documented)" },
        awaitSignal: { from: input.mlro, distinctFrom: [review], deadline: sarDue, onDeadline: "fail" },
        requires: [review],
        async execute({ providers, signal }) {
          await providers.slack!.postMessage(input.complianceChannel, `:memo: ${s.account}: MLRO ${signal!.by} decided to file a SAR. File it in the regulator's portal and record the reference on the case.`);
          return { ref: s.account, detail: { by: signal!.by } };
        },
      });
      for (let n = 1; n * POLICY.remindEveryDays < POLICY.sarDays; n++) {
        actions.push({
          id: `compliance.remind:${s.account}:${n}`,
          kind: "compliance.remind",
          provider: "slack",
          agent: "screening",
          gate: "auto",
          summary: { account: s.account, day: n * POLICY.remindEveryDays },
          waitUntil: new Date(now + n * POLICY.remindEveryDays * DAY).toISOString(),
          async execute({ providers, statuses }) {
            if (statuses[review] !== "awaiting_signal") throw new SkipAction("decided");
            return { ref: (await providers.slack!.postMessage(input.complianceChannel, `:hourglass: ${s.account} (${s.name}) has an undecided sanctions match for ${n * POLICY.remindEveryDays} days${strong ? "; payouts are on hold" : ""}.`)).ts };
          },
        });
      }
    }
    actions.push(post(`:mag: ${input.rescreenId} ${input.program}: ${screened.length} account(s) screened, ${toReview.length} potential match(es) to review, ${screened.filter((s) => s.cleared).length} previously cleared.`));
    return actions;
  },

  output(_ctx, results) {
    const s = out<Screened[]>(results, "screening");
    if (!s) return { mode: "blocked" };
    const review = s.filter((x) => x.hits.length && !x.cleared);
    return { mode: "rescreen", accounts: s.length, matches: review.length, held: review.filter((x) => x.hits.some((h) => h.score >= POLICY.holdScore)).length, previouslyCleared: s.filter((x) => x.cleared).length };
  },

  catalog: [
    { kind: "stripe.precautionary_hold", provider: "stripe", gate: "auto", description: "Strong match: payouts to manual at once" },
    { kind: "compliance.review", provider: "stripe", gate: "auto", description: "Signal: analyst decides true match (hold) or false positive" },
    { kind: "stripe.clear", provider: "stripe", gate: "auto", description: "False positive: record clearance for this hit set, release a precautionary hold" },
    { kind: "mlro.sar_decision", provider: "slack", gate: "auto", description: "Signal: MLRO (not the analyst) decides on a SAR within 30 days of detection" },
    { kind: "compliance.remind", provider: "slack", gate: "auto", description: "Reminder every 3 days while undecided" },
    { kind: "slack.post_rescreen", provider: "slack", gate: "auto", description: "Sweep summary" },
  ],
};
