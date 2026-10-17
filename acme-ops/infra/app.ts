import { App } from "aws-cdk-lib";
import { WORKFLOWS } from "../src/workflows";
import { WorkflowStack } from "./stack";

// cdk deploy AcmeOps-support-escalation            → one workflow
// cdk deploy --all                                  → all four, each independent
const app = new App();
const ctx = (k: string): string | undefined => app.node.tryGetContext(k);

for (const wf of Object.values(WORKFLOWS)) {
  new WorkflowStack(app, `AcmeOps-${wf.id}`, {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
    workflow: wf.id,
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
