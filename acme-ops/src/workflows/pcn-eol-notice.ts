import { z } from "zod";
import type { WorkflowDef } from "../kit/types";

// STUB — replaced by the real implementation.
export const pcnEolNotice: WorkflowDef<Record<string, unknown>> = {
  id: "pcn-eol-notice",
  title: "Product change and end-of-life notices",
  org: "Engineering",
  team: "product-engineering",
  description: "Not implemented yet.",
  input: z.record(z.string(), z.unknown()),
  agents: [],
  plan: () => [],
  output: () => ({}),
  catalog: [],
};
