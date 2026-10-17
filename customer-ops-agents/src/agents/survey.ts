import type { Deps } from "../deps";
import type { AgentResult, IntakeState, SurveyResult } from "../types";
import { SurveySchema } from "../types";

export const surveyKey = (email: string) => `survey#${email}`;

/**
 * Drafts the survey. Sending — and the atomic "at most one survey per
 * customer per cooldown" reservation — happens in dispatch after approval;
 * this early check only avoids wasting a model call.
 */
export async function runSurvey(s: IntakeState, d: Deps): Promise<AgentResult<SurveyResult>> {
  const recent = await d.store.get(surveyKey(s.intake.customer.email));
  if (recent && typeof recent.expiresAt === "number" && recent.expiresAt > d.now() && recent.runId !== s.runId) {
    return { agent: "survey", status: "ok", data: { subject: "", intro: "", questions: [], suppressed: true } };
  }
  const survey = await d.llm.structured({
    task: "survey",
    schema: SurveySchema,
    effort: "low",
    system: "Write a short, friendly customer satisfaction survey email (2-5 questions, include one 0-10 NPS question). No marketing fluff.",
    prompt: `Customer: ${s.intake.customer.name || s.intake.customer.email} (${s.intake.customer.company || "unknown company"}).\nContext: ${s.intake.summary}`,
  });
  return { agent: "survey", status: "ok", data: { ...survey, suppressed: false } };
}
