import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * Configurable policy (Kit v3).
 *
 * A workflow's code declares *what* its policy means (a zod schema); the
 * values — limits, thresholds, deadlines, routing rules, folder layouts,
 * template ids — live in `policies/<workflow>.json`, outside the logic.
 * A deployment overrides them without a code change:
 *
 *   defaults  policies/<workflow>.json (bundled with the runtime)
 *   ← file    POLICY_FILE=/path/to/policy.json        (container mount, Cloud Run secret, SPCS volume)
 *   ← inline  POLICY_JSON='{"reminders":{"days":[3]}}' (stack parameter, Secrets Manager, SSM)
 *
 * Objects merge key by key; arrays and scalars replace. The result is
 * validated against the schema at startup (an invalid policy stops the
 * runtime instead of running with a wrong rule) and fingerprinted. Every run
 * keeps the policy it started under, so a policy change never alters a run
 * that is already waiting on a timer or a signal.
 */
export interface PolicySpec<P> {
  schema: z.ZodType<P>;
  /** The shipped values, imported from policies/<workflow>.json. */
  defaults: unknown;
}

export interface EffectivePolicy {
  /** sha256 of the canonical JSON, first 12 hex chars. Recorded on every run. */
  version: string;
  values: unknown;
  /** Where the values came from, in merge order. */
  sources: string[];
}

export class PolicyError extends Error {
  override name = "PolicyError";
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Objects merge key by key; anything else in `over` replaces `base`. */
export function mergePolicy(base: unknown, over: unknown): unknown {
  if (!isObject(base) || !isObject(over)) return over === undefined ? base : over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = mergePolicy(base[k], v);
  return out;
}

const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : isObject(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v);

export const policyVersion = (values: unknown) => createHash("sha256").update(canonical(values)).digest("hex").slice(0, 12);

/** Resolves and validates a workflow's policy from its defaults and the environment. */
export function resolvePolicy(spec: PolicySpec<unknown>, env: Record<string, string | undefined> = {}, readFile: (path: string) => string = (p) => readFileSync(p, "utf8")): EffectivePolicy {
  let values = spec.defaults;
  const sources = ["defaults"];
  const parse = (text: string, where: string) => {
    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      throw new PolicyError(`${where} is not valid JSON: ${(err as Error).message}`);
    }
  };
  if (env.POLICY_FILE) {
    values = mergePolicy(values, parse(readFile(env.POLICY_FILE), `POLICY_FILE ${env.POLICY_FILE}`));
    sources.push(`file:${env.POLICY_FILE}`);
  }
  if (env.POLICY_JSON) {
    values = mergePolicy(values, parse(env.POLICY_JSON, "POLICY_JSON"));
    sources.push("env:POLICY_JSON");
  }
  const parsed = spec.schema.safeParse(values);
  if (!parsed.success) throw new PolicyError(`invalid policy: ${parsed.error.issues.map((i) => `${i.path.join(".") || "policy"}: ${i.message}`).join("; ")}`);
  return { version: policyVersion(parsed.data), values: parsed.data, sources };
}

/** JSON Schema of a policy, for `describe`, docs and agents that edit the policy file. */
export const policyJsonSchema = (spec: PolicySpec<unknown>) => z.toJSONSchema(spec.schema, { unrepresentable: "any" });
