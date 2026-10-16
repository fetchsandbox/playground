import { App } from "aws-cdk-lib";
import { CustomerOpsStack } from "./stack";

const app = new App();
const ctx = (k: string): string | undefined => app.node.tryGetContext(k);

new CustomerOpsStack(app, "CustomerOpsAgents", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  approverUserIds: ctx("approverUserIds"),
  defaultOwnerId: ctx("defaultOwnerId"),
  claudeModel: ctx("claudeModel"),
  jwtDiscoveryUrl: ctx("jwtDiscoveryUrl"),
  jwtAllowedClients: ctx("jwtAllowedClients")?.split(","),
  looplabsAccountId: ctx("looplabsAccountId"),
  looplabsExternalId: ctx("looplabsExternalId"),
});
