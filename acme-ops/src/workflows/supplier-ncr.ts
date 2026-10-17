import { z } from "zod";
import type { WorkflowDef } from "../kit/types";

// STUB — replaced by the real implementation.
export const supplierNcr: WorkflowDef<Record<string, unknown>> = {
  id: "supplier-ncr",
  title: "Supplier nonconformance and corrective action",
  org: "Quality",
  team: "supplier-quality",
  description: "Not implemented yet.",
  input: z.record(z.string(), z.unknown()),
  agents: [],
  plan: () => [],
  output: () => ({}),
  catalog: [],
};
