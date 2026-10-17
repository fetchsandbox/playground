import { z } from "zod";
import type { WorkflowDef } from "../kit/types";

// STUB — replaced by the real implementation.
export const collectionsCreditHold: WorkflowDef<Record<string, unknown>> = {
  id: "collections-credit-hold",
  title: "Collections and credit hold",
  org: "Finance",
  team: "ar-collections",
  description: "Not implemented yet.",
  input: z.record(z.string(), z.unknown()),
  agents: [],
  plan: () => [],
  output: () => ({}),
  catalog: [],
};
