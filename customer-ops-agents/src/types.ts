import { z } from "zod";

// ---------------------------------------------------------------------------
// Workflow state. Everything here travels through Step Functions, whose
// payload limit is 256 KB — keep agent outputs compact (summaries, ids),
// never raw provider dumps.
// ---------------------------------------------------------------------------

export interface WorkflowInput {
  /** = Step Functions execution name. Deterministic per Slack event, so it doubles as the dedupe key. */
  runId: string;
  requestText: string;
  requestedBy: { userId: string; userName?: string };
  slack: { channel: string; threadTs: string };
  receivedAt: string;
}

export const IntakeSchema = z.object({
  customer: z.object({
    email: z.string().describe("Customer contact email. Empty string if none was given."),
    name: z.string().describe("Contact's full name, or empty string"),
    company: z.string().describe("Company name, or empty string"),
  }),
  summary: z.string().describe("One sentence: what the requester wants"),
  urgency: z.enum(["low", "normal", "high"]),
  tasks: z.object({
    research: z.boolean().describe("Background research on the account is useful"),
    billing: z.boolean().describe("Billing status, invoices or payments are relevant"),
    survey: z.boolean().describe("A satisfaction survey should go to the customer"),
    quote: z.object({
      needed: z.boolean(),
      items: z.array(z.object({ description: z.string(), quantity: z.number().int().positive() })),
      requestedDiscountPct: z.number().min(0).max(100).describe("0 if none requested"),
    }),
  }),
});
export type Intake = z.infer<typeof IntakeSchema>;

export interface CrmContext {
  contactId: string;
  ownerId: string | null;
}

export interface IntakeState extends WorkflowInput {
  intake: Intake;
  crm: CrmContext;
}

export type AgentName = "research" | "quote" | "billing" | "survey";

export type AgentResult<T = unknown> =
  | { agent: AgentName; status: "ok"; data: T }
  | { agent: AgentName; status: "skipped" }
  | { agent: AgentName; status: "failed"; error: string; cause?: string };

export interface FanOutState extends IntakeState {
  agents: AgentResult[];
}

// --- Agent payloads -------------------------------------------------------

export const ResearchBriefSchema = z.object({
  accountSummary: z.string(),
  recentInteractions: z.array(z.string()).describe("Most recent first, max 5"),
  openDeals: z.array(z.string()),
  risks: z.array(z.string()),
  opportunities: z.array(z.string()),
});
export type ResearchBrief = z.infer<typeof ResearchBriefSchema>;

export interface QuoteResult {
  stripeCustomerId: string;
  stripeQuoteId: string;
  hubspotDealId: string;
  currency: string;
  lines: { priceId: string; product: string; quantity: number; unitAmount: number; subtotal: number }[];
  discountPct: number;
  totalCents: number;
  unmatched: string[];
  /** Discount above the auto-approve cap: the human approver sees a warning. */
  needsDiscountApproval: boolean;
}

export const BillingAssessmentSchema = z.object({
  health: z.enum(["good", "watch", "at_risk"]),
  notes: z.string(),
  proposedActions: z.array(z.string()).describe("Suggestions only; nothing here is executed automatically"),
});
export interface BillingResult extends z.infer<typeof BillingAssessmentSchema> {
  stripeCustomerId: string | null;
  outstandingCents: number;
  overdueInvoices: number;
  activeSubscriptions: string[];
}

export const SurveySchema = z.object({
  subject: z.string(),
  intro: z.string(),
  questions: z.array(z.string()).min(2).max(5),
});
export interface SurveyResult extends z.infer<typeof SurveySchema> {
  /** True when this customer was surveyed recently — dispatch will not send. */
  suppressed: boolean;
}

export const HandoffSchema = z.object({
  summary: z.string().describe("3-5 sentence internal handoff for the account owner"),
  nextSteps: z.array(z.string()),
  riskLevel: z.enum(["low", "medium", "high"]),
  customerEmail: z.object({
    subject: z.string(),
    body: z.string().describe("Plain text email to the customer. Do not invent prices; refer to the attached quote."),
  }),
});
export type Handoff = z.infer<typeof HandoffSchema>;

export type ActionKind = "finalize_quote" | "email_customer" | "send_survey" | "create_owner_task";

export interface HandoffState extends FanOutState {
  handoff: Handoff & { hubspotNoteId: string; actions: ActionKind[] };
}

export interface ApprovalDecision {
  decision: "approve" | "reject";
  decidedBy: string;
}

export interface ApprovedState extends HandoffState {
  approval: ApprovalDecision;
}

export interface ActionOutcome {
  action: ActionKind;
  status: "done" | "skipped" | "failed";
  detail: string;
}

export interface DispatchState extends ApprovedState {
  dispatch: ActionOutcome[];
}

export function agentData<T>(state: FanOutState, agent: AgentName): T | undefined {
  const r = state.agents.find((a) => a.agent === agent);
  return r?.status === "ok" ? (r.data as T) : undefined;
}
