import type { WorkflowDef } from "../kit/types";
import { returnsWarranty } from "./returns-warranty";
import { orderStatus } from "./order-status";
import { rfqQuote } from "./rfq-quote";
import { complianceDocs } from "./compliance-docs";
import { fieldServiceDispatch } from "./field-service-dispatch";
import { serviceRenewals } from "./service-renewals";
import { collectionsCreditHold } from "./collections-credit-hold";
import { distributorClaims } from "./distributor-claims";
import { pcnEolNotice } from "./pcn-eol-notice";
import { exportScreening } from "./export-screening";
import { accessJml } from "./access-jml";
import { licenseReclaim } from "./license-reclaim";
import { securityQuestionnaire } from "./security-questionnaire";
import { supplierNcr } from "./supplier-ncr";
import { incidentComms } from "./incident-comms";
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
  [returnsWarranty.id]: returnsWarranty,
  [orderStatus.id]: orderStatus,
  [rfqQuote.id]: rfqQuote,
  [complianceDocs.id]: complianceDocs,
  [fieldServiceDispatch.id]: fieldServiceDispatch,
  [serviceRenewals.id]: serviceRenewals,
  [collectionsCreditHold.id]: collectionsCreditHold,
  [distributorClaims.id]: distributorClaims,
  [pcnEolNotice.id]: pcnEolNotice,
  [exportScreening.id]: exportScreening,
  [accessJml.id]: accessJml,
  [licenseReclaim.id]: licenseReclaim,
  [securityQuestionnaire.id]: securityQuestionnaire,
  [supplierNcr.id]: supplierNcr,
  [incidentComms.id]: incidentComms,
};
