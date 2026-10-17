import type { WorkflowDef } from "../kit/types";
import { churnRiskSweep } from "./churn-risk-sweep";
import { onboardingKickoff } from "./onboarding-kickoff";
import { revenueReconciliation } from "./revenue-reconciliation";
import { supportEscalation } from "./support-escalation";

/** Every workflow ships as its own AgentCore runtime; this map only lets one image serve any of them. */
export const WORKFLOWS: Record<string, WorkflowDef<any>> = {
  [supportEscalation.id]: supportEscalation,
  [revenueReconciliation.id]: revenueReconciliation,
  [churnRiskSweep.id]: churnRiskSweep,
  [onboardingKickoff.id]: onboardingKickoff,
};
