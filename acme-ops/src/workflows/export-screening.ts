import { z } from "zod";
import type { WorkflowDef } from "../kit/types";

// STUB — replaced by the real implementation.
export const exportScreening: WorkflowDef<Record<string, unknown>> = {
  id: "export-screening",
  title: "Export screening and order hold",
  org: "Trade Compliance",
  team: "trade-compliance",
  description: "Not implemented yet.",
  input: z.record(z.string(), z.unknown()),
  agents: [],
  plan: () => [],
  output: () => ({}),
  catalog: [],
};
