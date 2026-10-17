import { z } from "zod";
import type { WorkflowDef } from "../kit/types";

// STUB — replaced by the real implementation.
export const serviceRenewals: WorkflowDef<Record<string, unknown>> = {
  id: "service-renewals",
  title: "Service and monitoring renewals",
  org: "Customer Success",
  team: "cs-ops",
  description: "Not implemented yet.",
  input: z.record(z.string(), z.unknown()),
  agents: [],
  plan: () => [],
  output: () => ({}),
  catalog: [],
};
