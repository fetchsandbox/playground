import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { App } from "aws-cdk-lib";
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

for (const wf of Object.values(WORKFLOWS)) {
  new WorkflowStack(app, `AcmeOps-${wf.id}`, {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
    workflow: wf.id,
    sourceCommit: ctx("sourceCommit") ?? process.env.WORKFLOW_SOURCE_COMMIT ?? "unrecorded",
    deploymentVersion: ctx("deploymentVersion") ?? "acme-ops-2.0.2-department-identities",
    manageDeliveryResourcePolicy: ctx("useExistingTraceDeliveryPolicy") === "true" ? false : undefined,
    org: wf.org,
    team: wf.team,
    description: wf.description,
    approverUserIds: ctx(`approvers:${wf.id}`) ?? ctx("approverUserIds"),
    approvalTtlHours: ctx("approvalTtlHours") ? Number(ctx("approvalTtlHours")) : undefined,
    claudeModel: ctx("claudeModel"),
    jwtDiscoveryUrl: ctx("jwtDiscoveryUrl"),
    jwtAllowedClients: ctx("jwtAllowedClients")?.split(","),
    looplabsAccountId: ctx("looplabsAccountId"),
    looplabsExternalId: ctx("looplabsExternalId"),
  });
}
