import { z } from "zod";
import type { WorkflowDef } from "../kit/types";

// STUB — replaced by the real implementation.
export const incidentComms: WorkflowDef<Record<string, unknown>> = {
  id: "incident-comms",
  title: "Incident communications",
  org: "IT",
  team: "it-operations",
  description: "Not implemented yet.",
  input: z.record(z.string(), z.unknown()),
  agents: [],
  plan: () => [],
  output: () => ({}),
  catalog: [],
};
