import { z } from "zod";
import type { WorkflowDef } from "../kit/types";

// STUB — replaced by the real implementation.
export const fieldServiceDispatch: WorkflowDef<Record<string, unknown>> = {
  id: "field-service-dispatch",
  title: "Field service dispatch",
  org: "Service",
  team: "field-service",
  description: "Not implemented yet.",
  input: z.record(z.string(), z.unknown()),
  agents: [],
  plan: () => [],
  output: () => ({}),
  catalog: [],
};
