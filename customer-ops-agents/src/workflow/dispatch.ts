import type { Deps } from "../deps";
import { surveyKey } from "../agents/survey";
import { FatalError, RetryableError, errorMessage, isRetryable } from "../lib/errors";
import { once } from "../lib/idempotency";
import { ttlFromNow, when } from "../lib/store";
import { runKey } from "./notify";
import { type ActionKind, type ActionOutcome, type ApprovedState, type DispatchState, type QuoteResult, type SurveyResult, agentData } from "../types";

/**
 * Executes the approved actions. Every action is wrapped in `once()`, so when
 * one action fails transiently we throw, the engine re-runs the whole
 * step, and the actions that already succeeded are replayed from the ledger
 * instead of being repeated (no second email, no second task).
 */
export async function runDispatch(s: ApprovedState, d: Deps): Promise<DispatchState> {
  // Defense in depth: the decision must be recorded on the run itself, not just passed in.
  const rec = await d.store.get(runKey(s.runId));
  if (rec?.phase !== "APPROVED") throw new FatalError(`run ${s.runId} is not approved (phase ${String(rec?.phase ?? "missing")})`);

  const quote = agentData<QuoteResult>(s, "quote");
  const survey = agentData<SurveyResult>(s, "survey");
  const email = s.intake.customer.email;
  const outcomes: ActionOutcome[] = [];
  let transient: unknown;

  const act = async (action: ActionKind, fn: () => Promise<string>) => {
    if (!s.handoff.actions.includes(action)) return;
    try {
      outcomes.push({ action, status: "done", detail: await once(d.store, `${s.runId}:action:${action}`, fn) });
    } catch (err) {
      if (isRetryable(err)) transient ??= err;
      outcomes.push({ action, status: "failed", detail: errorMessage(err) });
    }
  };

  // Ordered: the email references the finalized quote number.
  await act("finalize_quote", async () => {
    const q = await d.billing.finalizeQuote(quote!.stripeQuoteId, `${s.runId}:finalize`);
    await d.crm.updateDeal(quote!.hubspotDealId, { stage: d.config.dealStage.sent });
    return q.number ?? quote!.stripeQuoteId;
  });
  const finalized = outcomes.find((o) => o.action === "finalize_quote" && o.status === "done");
  const quoteNumber = finalized?.detail ?? null;
  if (finalized) finalized.detail = `Stripe quote ${quoteNumber} finalized`;

  if (s.handoff.actions.includes("email_customer") && !quoteNumber) {
    outcomes.push({ action: "email_customer", status: "skipped", detail: "quote was not finalized" });
  } else {
    await act("email_customer", async () => {
      const r = await d.mail.sendOnce({
        to: email,
        subject: s.handoff.customerEmail.subject,
        body: `${s.handoff.customerEmail.body}\n\nQuote reference: ${quoteNumber}`,
        effectKey: `${s.runId}:email_customer`,
      });
      return `emailed ${email} (${r.id}${r.deduped ? ", already sent" : ""})`;
    });
  }

  if (s.handoff.actions.includes("send_survey") && survey) {
    // Atomic per-customer rate limit: concurrent runs can't both survey the
    // same person. Re-entry by this same run (a retry) is allowed.
    const now = d.now();
    const reserved = await d.store.put(
      { pk: surveyKey(email), runId: s.runId, expiresAt: now + d.config.surveyCooldownDays * 86_400_000, ttl: ttlFromNow(d.config.surveyCooldownDays * 86_400, now) },
      when.notExistsOrExpired(now),
    );
    const holder = reserved ? s.runId : (await d.store.get(surveyKey(email)))?.runId;
    if (holder !== s.runId) {
      outcomes.push({ action: "send_survey", status: "skipped", detail: `customer already surveyed by run ${String(holder)}` });
    } else {
      await act("send_survey", async () => {
        const body = `${survey.intro}\n\n${survey.questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n\nJust reply to this email with your answers.`;
        const r = await d.mail.sendOnce({ to: email, subject: survey.subject, body, effectKey: `${s.runId}:send_survey` });
        return `survey sent (${r.id})`;
      });
      const failed = outcomes.find((o) => o.action === "send_survey" && o.status === "failed");
      if (failed && !transient) await d.store.delete(surveyKey(email), when.eq({ runId: s.runId }));
    }
  }

  await act("create_owner_task", async () => {
    const id = await d.crm.createTask(s.crm.contactId, {
      ownerId: s.crm.ownerId,
      subject: `Follow up: ${s.intake.summary}`.slice(0, 250),
      body: `${s.handoff.summary}\n\nNext steps:\n${s.handoff.nextSteps.map((n) => `- ${n}`).join("\n")}`,
    });
    return `HubSpot task ${id}`;
  });

  if (transient) throw new RetryableError(`dispatch incomplete, will retry: ${errorMessage(transient)}`);
  return { ...s, dispatch: outcomes };
}
