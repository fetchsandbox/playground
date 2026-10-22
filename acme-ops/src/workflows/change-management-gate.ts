import { z } from "zod";
import { FatalError, SkipAction } from "../kit/errors";
import type { PlannedAction, WorkflowDef } from "../kit/types";
import { Approvers, ChannelId, out } from "./shared";

// Engineering · platform-ops.
// Trigger: a merged pull request asks to go to production. The gate checks,
// in parallel, the change itself (merged, checks green, reviewed by someone
// other than the author), live operations (open P1/P2 incidents on the
// service, alerting monitors) and the freeze calendar. Then:
//   standard change, all clear → deploy automatically;
//   normal change → a CAB approver who isn't the author approves (Kit v2 signal);
//   emergency change → deploys now, CAB reviews afterwards within 24 h;
//   anything red → blocked, with the reason.
// After the deploy the service is watched (durable timer); if the error rate
// or a monitor degrades, the deployment is rolled back automatically (saga
// compensation) and the on-call incident gets a note.

export const POLICY = {
  watchMinutes: 15,
  /** Error rate (per cent) above which the watch fails. */
  maxErrorRatePct: 2,
  approvalHours: 8,
  emergencyReviewHours: 24,
  minApprovingReviews: 1,
} as const;

const Freeze = z.object({ from: z.iso.datetime(), to: z.iso.datetime(), reason: z.string().max(200) });
const Input = z.object({
  changeId: z.string().regex(/^CHG-[\w-]{3,40}$/, "change id like CHG-2026-0042"),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "owner/repo"),
  pullRequest: z.number().int().positive(),
  service: z.object({ name: z.string().regex(/^[\w-]{2,64}$/), pagerdutyServiceId: z.string().regex(/^[A-Z0-9]{5,12}$/), monitorIds: z.array(z.number().int().positive()).max(20).default([]), errorRateQuery: z.string().min(1).max(500) }),
  environment: z.string().regex(/^[\w-]{2,32}$/).default("production"),
  type: z.enum(["standard", "normal", "emergency"]),
  freezes: z.array(Freeze).max(50).default([]),
  opsChannel: ChannelId,
  /** CAB approvers. */
  approvers: Approvers,
});
type Input = z.infer<typeof Input>;

export interface ChangeFacts {
  merged: boolean;
  sha: string | null;
  author: string;
  approvingReviewers: string[];
  failedChecks: string[];
  pendingChecks: string[];
}
export interface OpsFacts {
  incidents: { id: string; urgency: string; title?: string }[];
  alerting: string[];
}
export interface Gate {
  mode: "deploy" | "needs_cab" | "emergency" | "blocked";
  reasons: string[];
}

const HOUR = 3_600_000;

/** The gate. Pure. */
export function decideGate(input: Input, change: ChangeFacts | undefined, ops: OpsFacts | undefined, now: number): Gate {
  const reasons: string[] = [];
  if (!change) return { mode: "blocked", reasons: ["the pull request could not be read"] };
  if (!ops) return { mode: "blocked", reasons: ["incidents and monitors could not be read"] };
  if (!change.merged || !change.sha) reasons.push("pull request is not merged");
  if (change.failedChecks.length) reasons.push(`failing checks: ${change.failedChecks.join(", ")}`);
  if (change.pendingChecks.length) reasons.push(`checks still running: ${change.pendingChecks.join(", ")}`);
  if (change.approvingReviewers.filter((r) => r !== change.author).length < POLICY.minApprovingReviews) reasons.push("no approving review from someone other than the author");
  const freeze = input.freezes.find((f) => Date.parse(f.from) <= now && now < Date.parse(f.to));
  const emergency = input.type === "emergency";
  // An emergency fix may ship during a freeze or an incident (often it IS the fix), never with failing checks.
  if (freeze && !emergency) reasons.push(`change freeze until ${freeze.to} (${freeze.reason})`);
  if (ops.incidents.length && !emergency) reasons.push(`open incident(s) on ${input.service.name}: ${ops.incidents.map((i) => i.id).join(", ")}`);
  if (ops.alerting.length && !emergency) reasons.push(`monitor(s) alerting: ${ops.alerting.join(", ")}`);
  if (reasons.length) return { mode: "blocked", reasons };
  return { mode: emergency ? "emergency" : input.type === "normal" ? "needs_cab" : "deploy", reasons: [] };
}

export const changeManagementGate: WorkflowDef<Input> = {
  id: "change-management-gate",
  title: "Change management gate",
  org: "Engineering",
  team: "platform-ops",
  description:
    "Gate a production deploy on the change (merged, green, reviewed by someone else), live operations (incidents, alerting monitors) and freezes; standard changes deploy, normal ones need a CAB approver who isn't the author, emergencies are reviewed after. A degraded watch window rolls back automatically.",
  input: Input,
  audit: true,
  tickEvery: "rate(1 minute)",
  agents: [
    {
      name: "change-check",
      needs: ["github"],
      async run({ input, providers }) {
        const gh = providers.github!;
        const pr = await gh.getPullRequest(input.repo, input.pullRequest);
        const reviews = await gh.listReviews(input.repo, input.pullRequest);
        const latest = new Map<string, string>();
        for (const r of reviews) latest.set(r.user.login, r.state);
        const sha = pr.merged ? pr.merge_commit_sha : null;
        const runs = sha ? await gh.checkRuns(input.repo, sha) : [];
        const data: ChangeFacts = {
          merged: pr.merged,
          sha,
          author: pr.user.login,
          approvingReviewers: [...latest].filter(([, s]) => s === "APPROVED").map(([u]) => u),
          failedChecks: runs.filter((r) => r.status === "completed" && r.conclusion !== "success" && r.conclusion !== "skipped" && r.conclusion !== "neutral").map((r) => r.name),
          pendingChecks: runs.filter((r) => r.status !== "completed").map((r) => r.name),
        };
        return { summary: `PR #${pr.number} ${pr.merged ? "merged" : pr.state}, ${data.failedChecks.length} failing check(s)`, data };
      },
    },
    {
      name: "ops-check",
      needs: ["pagerduty", "datadog"],
      async run({ input, providers }) {
        const incidents = (await providers.pagerduty!.openIncidents([input.service.pagerdutyServiceId])).filter((i) => i.urgency === "high");
        const alerting: string[] = [];
        for (const id of input.service.monitorIds) {
          const m = await providers.datadog!.monitor(id);
          if (m.overall_state === "Alert" || m.overall_state === "Warn") alerting.push(`${m.name} (${m.overall_state})`);
        }
        return { summary: `${incidents.length} high-urgency incident(s), ${alerting.length} monitor(s) alerting`, data: { incidents: incidents.map((i) => ({ id: i.id, urgency: i.urgency, title: i.title })), alerting } satisfies OpsFacts };
      },
    },
  ],

  compose: {
    name: "gate",
    async run({ input, startedAt }, results) {
      const g = decideGate(input, out<ChangeFacts>(results, "change-check"), out<OpsFacts>(results, "ops-check"), startedAt.getTime());
      return { summary: `${g.mode}${g.reasons.length ? `: ${g.reasons.join("; ")}` : ""}`, data: g };
    },
  },

  plan({ input, startedAt }, results) {
    const g = out<Gate>(results, "gate");
    const change = out<ChangeFacts>(results, "change-check");
    if (!g) return [];
    const at = (h: number) => new Date(startedAt.getTime() + h * HOUR).toISOString();
    const ids = { cab: `cab.approve:${input.changeId}`, deploy: `github.deploy:${input.changeId}`, watch: `datadog.watch:${input.changeId}`, done: `github.mark_success:${input.changeId}`, review: `cab.post_review:${input.changeId}` };
    const actions: PlannedAction<Input>[] = [];
    const post = (id: string, text: () => string, extra: Partial<PlannedAction<Input>> = {}): PlannedAction<Input> => ({
      id,
      kind: "slack.post_change",
      provider: "slack",
      agent: "gate",
      gate: "auto",
      summary: { channel: input.opsChannel },
      async execute({ providers }) {
        const m = await providers.slack!.postMessage(input.opsChannel, text());
        return { ref: m.ts };
      },
      ...extra,
    });

    if (g.mode === "blocked") {
      actions.push(post("slack.post_change:blocked", () => `:no_entry: ${input.changeId} (${input.repo}#${input.pullRequest}) blocked: ${g.reasons.join("; ")}.`));
      return actions;
    }
    if (g.mode === "needs_cab") {
      actions.push({
        id: ids.cab,
        kind: "cab.approve",
        provider: "github",
        agent: "gate",
        gate: "auto",
        summary: { change: input.changeId, author: change!.author },
        // Nobody approves their own change.
        awaitSignal: { from: input.approvers ?? [], notFrom: [change!.author], deadline: at(POLICY.approvalHours), onDeadline: "reject" },
        async execute({ signal }) {
          return { ref: input.changeId, detail: { approvedBy: signal?.by } };
        },
      });
    }
    actions.push({
      id: ids.deploy,
      kind: "github.deploy",
      provider: "github",
      agent: "gate",
      gate: "auto",
      summary: { repo: input.repo, sha: change!.sha, environment: input.environment, type: input.type },
      ...(g.mode === "needs_cab" ? { requires: [ids.cab] } : {}),
      async execute({ providers }) {
        const gh = providers.github!;
        // Remember what was live, so a rollback knows where to go.
        const previous = (await gh.listDeployments(input.repo, input.environment)).find((d) => d.sha !== change!.sha);
        const existing = (await gh.listDeployments(input.repo, input.environment)).find((d) => d.payload?.change_id === input.changeId);
        if (existing) return { ref: String(existing.id), detail: { reused: true, previousSha: previous?.sha ?? null } };
        const d = await gh.createDeployment(input.repo, { ref: change!.sha!, environment: input.environment, description: `${input.changeId} (${input.type})`, payload: { change_id: input.changeId } });
        await gh.setDeploymentStatus(input.repo, d.id, "in_progress", `${input.changeId}: deploying`);
        return { ref: String(d.id), detail: { previousSha: previous?.sha ?? null } };
      },
      async compensate({ providers }, receipt) {
        // Roll back: mark this deployment failed and deploy what was live before.
        const gh = providers.github!;
        await gh.setDeploymentStatus(input.repo, Number(receipt.ref), "failure", `${input.changeId}: rolled back after the watch window`);
        const prev = receipt.detail?.previousSha as string | null;
        if (!prev) throw new FatalError("no previous deployment to roll back to");
        const r = await gh.createDeployment(input.repo, { ref: prev, environment: input.environment, description: `Rollback of ${input.changeId}`, payload: { rollback_of: input.changeId } });
        // The outcome post is skipped by the rollback, so the rollback announces itself (best effort).
        await providers.slack?.postMessage(input.opsChannel, `:rewind: ${input.changeId} degraded ${input.service.name} and was rolled back to ${prev.slice(0, 7)}.`).catch(() => undefined);
        return { ref: String(r.id), detail: { rolledBackTo: prev } };
      },
    });
    actions.push({
      id: ids.watch,
      kind: "datadog.watch",
      provider: "datadog",
      agent: "gate",
      gate: "auto",
      summary: { minutes: POLICY.watchMinutes, maxErrorRatePct: POLICY.maxErrorRatePct },
      requires: [ids.deploy],
      // The window starts when the deploy happened (for a normal change, after the CAB approval).
      delayAfter: { action: ids.deploy, ms: POLICY.watchMinutes * 60_000 },
      onFailure: "compensate",
      async execute({ providers }) {
        const now = Math.floor(Date.now() / 1000);
        const rate = await providers.datadog!.lastValue(input.service.errorRateQuery, now - POLICY.watchMinutes * 60, now);
        const alerting: string[] = [];
        for (const id of input.service.monitorIds) {
          const m = await providers.datadog!.monitor(id);
          if (m.overall_state === "Alert") alerting.push(m.name);
        }
        if ((rate !== null && rate > POLICY.maxErrorRatePct) || alerting.length) throw new FatalError(`service degraded after deploy: error rate ${rate ?? "?"}%${alerting.length ? `, alerting ${alerting.join(", ")}` : ""}`);
        return { ref: input.changeId, detail: { errorRatePct: rate } };
      },
    });
    actions.push({
      id: ids.done,
      kind: "github.mark_success",
      provider: "github",
      agent: "gate",
      gate: "auto",
      summary: { change: input.changeId },
      requires: [ids.watch],
      async execute({ providers, applied }) {
        const id = Number(applied[ids.deploy]!.ref);
        await providers.github!.setDeploymentStatus(input.repo, id, "success", `${input.changeId}: healthy after ${POLICY.watchMinutes} min`);
        return { ref: String(id) };
      },
    });
    if (g.mode === "emergency") {
      actions.push({
        id: ids.review,
        kind: "cab.post_review",
        provider: "github",
        agent: "gate",
        gate: "auto",
        summary: { change: input.changeId, within: `${POLICY.emergencyReviewHours} h` },
        awaitSignal: { from: input.approvers ?? [], notFrom: [change!.author], deadline: at(POLICY.emergencyReviewHours), onDeadline: "reject" },
        after: [ids.watch],
        async execute({ signal }) {
          return { ref: input.changeId, detail: { reviewedBy: signal?.by } };
        },
      });
    }
    actions.push(post("slack.post_change:start", () => `${g.mode === "emergency" ? ":fire: EMERGENCY" : ":rocket:"} ${input.changeId} (${input.repo}#${input.pullRequest}): ${g.mode === "needs_cab" ? "waiting for a CAB approver" : "deploying"}; watching ${POLICY.watchMinutes} min.`));
    actions.push(
      post("slack.post_change:outcome", () => "", {
        after: [ids.watch],
        async execute({ providers, statuses }) {
          const ok = statuses[ids.watch] === "applied";
          const deployed = statuses[ids.deploy];
          if (deployed === "skipped") throw new SkipAction("never deployed");
          const m = await providers.slack!.postMessage(input.opsChannel, ok ? `:white_check_mark: ${input.changeId} healthy in ${input.environment}.` : `:rewind: ${input.changeId} degraded the service and was rolled back.`);
          return { ref: m.ts };
        },
      }),
    );
    return actions;
  },

  output(_ctx, results) {
    const g = out<Gate>(results, "gate");
    return g ? { mode: g.mode, reasons: g.reasons } : { mode: "not decided" };
  },

  catalog: [
    { kind: "cab.approve", provider: "github", gate: "auto", description: "Signal: a CAB approver who isn't the author approves a normal change" },
    { kind: "github.deploy", provider: "github", gate: "auto", description: "GitHub deployment of the merged commit; compensated by a rollback deployment" },
    { kind: "datadog.watch", provider: "datadog", gate: "auto", description: "Watch window: error rate and monitors; degradation rolls back" },
    { kind: "github.mark_success", provider: "github", gate: "auto", description: "Deployment status success after a healthy watch" },
    { kind: "cab.post_review", provider: "github", gate: "auto", description: "Signal: CAB reviews an emergency change within 24 h" },
    { kind: "slack.post_change", provider: "slack", gate: "auto", description: "Start, block and outcome posts" },
  ],
};
