import { describe, expect, it } from "vitest";
import { z } from "zod";
import { mergePolicy, PolicyError, policyVersion, resolvePolicy } from "../src/kit/policy";
import type { WorkflowDef } from "../src/kit/types";
import { MemoryStore } from "../src/kit/store";
import { NOW, startWorld } from "./fake-world";

const schema = z.object({
  store: z.object({ provider: z.enum(["box", "dropbox"]), root: z.string().min(1) }),
  reminders: z.object({ days: z.array(z.number().int().positive()).min(1) }),
  limit: z.number().int().min(0),
});
const defaults = { store: { provider: "box", root: "0" }, reminders: { days: [3, 7] }, limit: 5 };
const spec = { schema, defaults };

describe("configurable policy", () => {
  it("merges objects key by key; arrays and scalars replace", () => {
    expect(mergePolicy(defaults, { store: { provider: "dropbox" }, reminders: { days: [1] } })).toEqual({ store: { provider: "dropbox", root: "0" }, reminders: { days: [1] }, limit: 5 });
  });

  it("layers defaults ← POLICY_FILE ← POLICY_JSON, validates and fingerprints", () => {
    const files: Record<string, string> = { "/etc/acme/policy.json": JSON.stringify({ store: { provider: "dropbox", root: "/Acme" }, limit: 9 }) };
    const p = resolvePolicy(spec, { POLICY_FILE: "/etc/acme/policy.json", POLICY_JSON: '{"limit":2}' }, (f) => files[f]!);
    expect(p.values).toEqual({ store: { provider: "dropbox", root: "/Acme" }, reminders: { days: [3, 7] }, limit: 2 });
    expect(p.sources).toEqual(["defaults", "file:/etc/acme/policy.json", "env:POLICY_JSON"]);
    expect(p.version).toMatch(/^[0-9a-f]{12}$/);
    // The fingerprint ignores key order, so the same policy always has the same version.
    expect(policyVersion({ b: 1, a: [1, 2] })).toBe(policyVersion({ a: [1, 2], b: 1 }));
    expect(resolvePolicy(spec).version).not.toBe(p.version);
  });

  it("rejects an invalid policy with every problem named", () => {
    expect(() => resolvePolicy(spec, { POLICY_JSON: '{"store":{"provider":"s3"},"limit":-1}' })).toThrow(PolicyError);
    expect(() => resolvePolicy(spec, { POLICY_JSON: '{"store":{"provider":"s3"},"limit":-1}' })).toThrow(/store\.provider: .*; limit: /);
    expect(() => resolvePolicy(spec, { POLICY_JSON: "{oops" })).toThrow(/POLICY_JSON is not valid JSON/);
  });

  it("each run keeps the policy it started under; describe exposes values, version and schema", async () => {
    const w = await startWorld();
    try {
      const wf: WorkflowDef<{ n: number }> = {
        id: "policy-probe",
        title: "Policy probe",
        org: "Test",
        team: "kit",
        description: "Reads its policy",
        input: z.object({ n: z.number() }),
        policy: spec,
        agents: [{ name: "read", needs: [], run: async ({ policy }) => ({ summary: "read", data: (policy as z.infer<typeof schema>).limit }) }],
        plan: () => [],
        output: (_c, r) => ({ limit: r.ok.read as number }),
        catalog: [],
      };
      const first = w.engine(wf, { now: () => NOW, policy: resolvePolicy(spec, { POLICY_JSON: '{"limit":1}' }) });
      const a = await first.handle({ action: "start", runId: "a", input: { n: 1 }, requestedBy: { userId: "U1" } });
      expect(a.body.output).toEqual({ limit: 1 });
      expect(a.body.policyVersion).toBe(first.policy!.version);
      const d = first.describe();
      expect(d.policy).toMatchObject({ version: first.policy!.version, values: { limit: 1 }, sources: ["defaults", "env:POLICY_JSON"] });
      expect((d.policy!.schema as any).properties.store.properties.provider.enum).toEqual(["box", "dropbox"]);

      // Without an override the engine runs on the validated defaults.
      expect(w.engine(wf).policy).toMatchObject({ values: defaults, sources: ["defaults"] });
    } finally {
      await w.close();
    }
  });

  it("a policy change never alters a run already waiting on a timer", async () => {
    const w = await startWorld();
    try {
      const wf: WorkflowDef<{ n: number }> = {
        id: "policy-timer",
        title: "Policy timer",
        org: "Test",
        team: "kit",
        description: "Uses its policy after a wait",
        input: z.object({ n: z.number() }),
        policy: spec,
        tickEvery: "rate(1 hour)",
        agents: [],
        plan: ({ policy }) => [
          {
            id: "later",
            kind: "later",
            provider: "slack",
            agent: "plan",
            gate: "auto",
            summary: {},
            waitUntil: new Date(NOW + 3_600_000).toISOString(),
            execute: async () => ({ ref: `limit-${(policy as z.infer<typeof schema>).limit}` }),
          },
        ],
        output: () => ({}),
        catalog: [{ kind: "later", provider: "slack", gate: "auto", description: "" }],
      };
      const store = new MemoryStore();
      const clock = { t: NOW };
      const v1 = resolvePolicy(spec, { POLICY_JSON: '{"limit":1}' });
      await w.engine(wf, { store, now: () => clock.t, policy: v1 }).handle({ action: "start", runId: "t", input: { n: 1 }, requestedBy: { userId: "U1" } });
      // The deployment's policy changes; the new container picks up the waiting run.
      clock.t = NOW + 2 * 3_600_000;
      const next = w.engine(wf, { store, now: () => clock.t, policy: resolvePolicy(spec, { POLICY_JSON: '{"limit":7}' }) });
      await next.handle({ action: "tick" });
      const s = (await next.handle({ action: "status", runId: "t" })).body;
      expect(s.policyVersion).toBe(v1.version);
      expect(s.actions[0]).toMatchObject({ status: "applied", ref: "limit-1" });
    } finally {
      await w.close();
    }
  });
});
