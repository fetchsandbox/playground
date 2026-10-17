import type { WorkflowDef } from "./types";

/**
 * Loads the workflow defined in `src/workflows/<id>.ts`. There is no central
 * registry: adding a workflow is adding its file, so workflows ship (and are
 * reviewed) independently. esbuild bundles every file this pattern matches.
 */
export async function loadWorkflow(id: string): Promise<WorkflowDef<unknown> | undefined> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || id === "shared") return undefined;
  let mod: Record<string, unknown>;
  try {
    mod = await import(`../workflows/${id}.ts`);
  } catch {
    return undefined;
  }
  return Object.values(mod).find((v): v is WorkflowDef<unknown> => !!v && typeof v === "object" && (v as { id?: unknown }).id === id);
}
