import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, RemovalPolicy, Stack, type StackProps, Tags } from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

const projectDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface WorkflowStackProps extends StackProps {
  workflow: string;
  org: string;
  team: string;
  description: string;
  /** Comma-separated user ids allowed to approve when a run doesn't name approvers. */
  approverUserIds?: string;
  approvalTtlHours?: number;
  claudeModel?: string;
  /** Inbound auth: IAM SigV4 by default, or the control plane's OIDC JWTs. */
  jwtDiscoveryUrl?: string;
  jwtAllowedClients?: string[];
  /** Cross-account role the control plane (LoopLabs) assumes to call InvokeAgentRuntime. */
  looplabsAccountId?: string;
  looplabsExternalId?: string;
}

/** One workflow = one AgentCore runtime, one state table, one secret. Nothing is shared between workflows. */
export class WorkflowStack extends Stack {
  constructor(scope: Construct, id: string, props: WorkflowStackProps) {
    super(scope, id, props);
    Tags.of(this).add("acme:workflow", props.workflow);
    Tags.of(this).add("acme:org", props.org);
    Tags.of(this).add("acme:team", props.team);

    const table = new dynamodb.Table(this, "State", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Fill after deploy with the provider keys this workflow uses (see README).
    const secret = new secretsmanager.Secret(this, "Secrets", { description: `acme-ops ${props.workflow} provider credentials (JSON)` });

    const runtime = new agentcore.Runtime(this, "Runtime", {
      runtimeName: `acme_${props.workflow.replaceAll("-", "_")}`,
      description: props.description.slice(0, 1000),
      agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromAsset(projectDir, {
        platform: Platform.LINUX_ARM64,
        buildArgs: { WORKFLOW: props.workflow },
      }),
      protocolConfiguration: agentcore.ProtocolType.HTTP,
      authorizerConfiguration: props.jwtDiscoveryUrl
        ? agentcore.RuntimeAuthorizerConfiguration.usingJWT(props.jwtDiscoveryUrl, props.jwtAllowedClients)
        : agentcore.RuntimeAuthorizerConfiguration.usingIAM(),
      environmentVariables: {
        WORKFLOW: props.workflow,
        DYNAMODB_TABLE: table.tableName,
        SECRET_ARN: secret.secretArn,
        ANTHROPIC_MODEL: props.claudeModel ?? "claude-opus-5-5",
        APPROVER_USER_IDS: props.approverUserIds ?? "",
        APPROVAL_TTL_HOURS: String(props.approvalTtlHours ?? 24),
      },
      tracingEnabled: true,
    });
    table.grantReadWriteData(runtime.role);
    secret.grantRead(runtime.role);

    if (props.looplabsAccountId) {
      const invoker = new iam.Role(this, "LoopLabsInvoker", {
        assumedBy: new iam.AccountPrincipal(props.looplabsAccountId),
        externalIds: props.looplabsExternalId ? [props.looplabsExternalId] : undefined,
        description: `Assumed by LoopLabs to invoke the ${props.workflow} AgentCore runtime`,
      });
      runtime.grantInvoke(invoker);
      new CfnOutput(this, "LoopLabsInvokerRoleArn", { value: invoker.roleArn });
    }

    new CfnOutput(this, "AgentRuntimeArn", { value: runtime.agentRuntimeArn });
    new CfnOutput(this, "SecretArn", { value: secret.secretArn });
    new CfnOutput(this, "TableName", { value: table.tableName });
  }
}
