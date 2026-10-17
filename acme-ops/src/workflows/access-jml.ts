import { z } from "zod";
import type { WorkflowDef } from "../kit/types";

// STUB — replaced by the real implementation.
export const accessJml: WorkflowDef<Record<string, unknown>> = {
  id: "access-jml",
  title: "Joiner, mover, leaver access",
  org: "IT",
  team: "it-identity",
  description: "Not implemented yet.",
  input: z.record(z.string(), z.unknown()),
  agents: [],
  plan: () => [],
  output: () => ({}),
  catalog: [],
};
