import { z } from "zod";
import type { WorkflowDef } from "../kit/types";

// STUB — replaced by the real implementation.
export const rfqQuote: WorkflowDef<Record<string, unknown>> = {
  id: "rfq-quote",
  title: "RFQ to quote",
  org: "Sales",
  team: "sales-ops",
  description: "Not implemented yet.",
  input: z.record(z.string(), z.unknown()),
  agents: [],
  plan: () => [],
  output: () => ({}),
  catalog: [],
};
