import { z } from "zod";
import type { WorkflowDef } from "../kit/types";

// STUB — replaced by the real implementation.
export const licenseReclaim: WorkflowDef<Record<string, unknown>> = {
  id: "license-reclaim",
  title: "SaaS license reclaim",
  org: "IT",
  team: "it-asset-mgmt",
  description: "Not implemented yet.",
  input: z.record(z.string(), z.unknown()),
  agents: [],
  plan: () => [],
  output: () => ({}),
  catalog: [],
};
