import { z } from "zod";
import type { WorkflowDef } from "../kit/types";

// STUB — replaced by the real implementation.
export const orderStatus: WorkflowDef<Record<string, unknown>> = {
  id: "order-status",
  title: "Order status and expedite",
  org: "Customer Experience",
  team: "cx-service",
  description: "Not implemented yet.",
  input: z.record(z.string(), z.unknown()),
  agents: [],
  plan: () => [],
  output: () => ({}),
  catalog: [],
};
