import { z } from "zod";
import type { WorkflowDef } from "../kit/types";

// STUB — replaced by the real implementation.
export const returnsWarranty: WorkflowDef<Record<string, unknown>> = {
  id: "returns-warranty",
  title: "Returns and warranty (RMA)",
  org: "Customer Experience",
  team: "cx-service",
  description: "Not implemented yet.",
  input: z.record(z.string(), z.unknown()),
  agents: [],
  plan: () => [],
  output: () => ({}),
  catalog: [],
};
