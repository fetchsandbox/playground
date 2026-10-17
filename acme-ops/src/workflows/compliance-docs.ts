import { z } from "zod";
import type { WorkflowDef } from "../kit/types";

// STUB — replaced by the real implementation.
export const complianceDocs: WorkflowDef<Record<string, unknown>> = {
  id: "compliance-docs",
  title: "Compliance documents on request",
  org: "Quality",
  team: "quality-compliance",
  description: "Not implemented yet.",
  input: z.record(z.string(), z.unknown()),
  agents: [],
  plan: () => [],
  output: () => ({}),
  catalog: [],
};
