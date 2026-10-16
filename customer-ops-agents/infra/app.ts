import { App } from "aws-cdk-lib";
import { CustomerOpsStack } from "./stack";

const app = new App();
new CustomerOpsStack(app, "CustomerOpsAgents", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  approverUserIds: app.node.tryGetContext("approverUserIds"),
  defaultOwnerId: app.node.tryGetContext("defaultOwnerId"),
  claudeModel: app.node.tryGetContext("claudeModel"),
});
