import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { App } from "aws-cdk-lib";
import { resolvePolicy } from "../src/kit/policy";
import { loadWorkflow } from "../src/kit/load";
import { WorkflowStack } from "./stack";

// One stack per workflow file in src/workflows/ (shared.ts is helpers, not a workflow).
const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "workflows");
const ids = readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "shared.ts").map((f) => f.slice(0, -3)).sort();
const WORKFLOWS = (await Promise.all(ids.map(loadWorkflow))).filter((w) => w !== undefined);

// cdk deploy AcmeOps-support-escalation            → one workflow
// cdk deploy --all                                  → all nineteen, each independent
const app = new App();
const ctx = (k: string): string | undefined => app.node.tryGetContext(k);

/**
 * Kit v3 policy overrides, checked at synth time so an invalid policy never deploys:
 *   cdk deploy AcmeOps-<id> -c policyFile:<id>=./my-policy.json
 * The file is merged over policies/<id>.json and shipped as POLICY_JSON. Keep sensitive values
 * (none of the shipped policies hold any) in the stack's secret under POLICY_JSON instead.
 */
function policyOverride(wf: (typeof WORKFLOWS)[number]): string | undefined {
  const file = ctx(`policyFile:${wf.id}`);
  if (!file) return undefined;
  if (!wf.policy) throw new Error(`${wf.id} has no configurable policy; remove -c policyFile:${wf.id}`);
  const text = readFileSync(file, "utf8");
  const resolved = resolvePolicy(wf.policy, { POLICY_JSON: text });
  console.error(`${wf.id}: policy ${resolved.version} from ${file}`);
  return JSON.stringify(JSON.parse(text));
}

for (const wf of Object.values(WORKFLOWS)) {
  new WorkflowStack(app, `AcmeOps-${wf.id}`, {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
    workflow: wf.id,
    looplabsControlConfig: wf.id === "product-cancellation" ? ctx("looplabsControlConfig") : undefined,
    containerRepository: ctx("containerWorkflow") === wf.id ? ctx("containerRepository") : undefined,
    containerTag: ctx("containerWorkflow") === wf.id ? ctx("containerTag") : undefined,
    sourceCommit: ctx("sourceCommit") ?? process.env.WORKFLOW_SOURCE_COMMIT ?? "unrecorded",
    deploymentVersion: ctx("deploymentVersion") ?? "acme-ops-2.0.2-department-identities",
    manageDeliveryResourcePolicy: ctx("useExistingTraceDeliveryPolicy") === "true" ? false : undefined,
    org: wf.org,
    team: wf.team,
    description: wf.description,
    tickEvery: wf.tickEvery,
    policyJson: policyOverride(wf),
    approverUserIds: ctx(`approvers:${wf.id}`) ?? ctx("approverUserIds"),
    approvalTtlHours: ctx("approvalTtlHours") ? Number(ctx("approvalTtlHours")) : undefined,
    claudeModel: ctx("claudeModel"),
    jwtDiscoveryUrl: ctx("jwtDiscoveryUrl"),
    jwtAllowedClients: ctx("jwtAllowedClients")?.split(","),
    looplabsAccountId: ctx("looplabsAccountId"),
    looplabsExternalId: ctx("looplabsExternalId"),
  });
}
