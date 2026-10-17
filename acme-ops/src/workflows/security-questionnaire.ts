import { z } from "zod";
import type { WorkflowDef } from "../kit/types";

// STUB — replaced by the real implementation.
export const securityQuestionnaire: WorkflowDef<Record<string, unknown>> = {
  id: "security-questionnaire",
  title: "Security questionnaire responder",
  org: "IT",
  team: "it-security",
  description: "Not implemented yet.",
  input: z.record(z.string(), z.unknown()),
  agents: [],
  plan: () => [],
  output: () => ({}),
  catalog: [],
};
