# Workflow policies

Each file here holds one workflow's policy: the limits, deadlines, routing
rules, folder layouts and template ids its owners may change. The workflow's
code declares what each setting means (a zod schema with a description per
field) and reads the values only through `ctx.policy`. Nothing in this folder
is a secret.

| How | Use it for |
|---|---|
| Edit `policies/<workflow>.json` | Your fork's defaults, reviewed like code |
| `POLICY_FILE=/path/override.json` | A file mounted into the container (Cloud Run secret volume, SPCS stage volume, Kubernetes ConfigMap) |
| `POLICY_JSON='{"…":…}'` | A stack parameter or a key in the runtime's secret |
| `cdk deploy AcmeOps-<workflow> -c policyFile:<workflow>=override.json` | AWS AgentCore; validated at synth time |

Overrides merge over the defaults: objects key by key, lists and values
replace. The runtime validates the result at startup and refuses to start on
an invalid policy, naming every bad field. `{"action":"describe"}` returns the
effective values, their version (a fingerprint) and the JSON Schema, so a
person or a coding agent can change a policy safely:

```bash
curl -s localhost:8080/invocations -d '{"action":"describe"}' | jq .policy
```

Every run records the policy version it started under and keeps that policy
until it finishes, so a change never alters a run that is already waiting on a
reminder or a signature.

Change a policy, then run `npm test`. A workflow's tests run on its shipped
defaults; if you change a default, update the tests that depend on it.
