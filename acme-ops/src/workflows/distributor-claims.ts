import { z } from "zod";
import type { WorkflowDef } from "../kit/types";

// STUB — replaced by the real implementation.
export const distributorClaims: WorkflowDef<Record<string, unknown>> = {
  id: "distributor-claims",
  title: "Distributor rebate and point-of-sale claims",
  org: "Finance",
  team: "channel-finance",
  description: "Not implemented yet.",
  input: z.record(z.string(), z.unknown()),
  agents: [],
  plan: () => [],
  output: () => ({}),
  catalog: [],
};
