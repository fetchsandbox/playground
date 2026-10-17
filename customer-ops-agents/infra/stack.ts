import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

const projectDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface CustomerOpsProps extends StackProps {
  /** Comma-separated Slack user ids allowed to approve (empty = anyone LoopLabs forwards). */
  approverUserIds?: string;
  defaultOwnerId?: string;
  claudeModel?: string;
  /**
   * Inbound auth. Default is IAM (SigV4). Set an OIDC discovery URL to let
   * LoopLabs call with JWTs from its identity provider instead.
   */
  jwtDiscoveryUrl?: string;
  jwtAllowedClients?: string[];
  /** Create a role LoopLabs can assume (cross-account, with an external id) to invoke the runtime. */
  looplabsAccountId?: string;
  looplabsExternalId?: string;
}

export class CustomerOpsStack extends Stack {
  constructor(scope: Construct, id: string, props: CustomerOpsProps = {}) {
    super(scope, id, props);

    // --- Durable state: run checkpoints, idempotency ledger, leases, rate limits.
    const table = new dynamodb.Table(this, "State", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // Sparse index of open runs (only those items carry `open`), used by `sweep`.
    table.addGlobalSecondaryIndex({
      indexName: "open-index",
      partitionKey: { name: "open", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "updatedAt", type: dynamodb.AttributeType.NUMBER },
    });

    // Fill after deploy: aws secretsmanager put-secret-value (see README).
    const secret = new secretsmanager.Secret(this, "Secrets", {
      description: "customer-ops-agents API credentials (JSON). See README for keys.",
    });

    // --- The agent: one ARM64 container on AgentCore Runtime.
    const runtime = new agentcore.Runtime(this, "Runtime", {
      runtimeName: "customer_ops_agents",
      description: "Parallel customer-ops agents: research, quote, billing, survey, handoff — with human approval",
      agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromAsset(projectDir, { platform: Platform.LINUX_ARM64 }),
      protocolConfiguration: agentcore.ProtocolType.HTTP,
      authorizerConfiguration: props.jwtDiscoveryUrl
        ? agentcore.RuntimeAuthorizerConfiguration.usingJWT(props.jwtDiscoveryUrl, props.jwtAllowedClients)
        : agentcore.RuntimeAuthorizerConfiguration.usingIAM(),
      environmentVariables: {
        TABLE_NAME: table.tableName,
        SECRET_ARN: secret.secretArn,
        CLAUDE_MODEL: props.claudeModel ?? "claude-opus-5-5",
        APPROVER_USER_IDS: props.approverUserIds ?? "",
        DEFAULT_OWNER_ID: props.defaultOwnerId ?? "",
      },
      tracingEnabled: true,
    });
    table.grantReadWriteData(runtime.role);
    secret.grantRead(runtime.role);

    // --- How LoopLabs gets in (IAM mode): a role it assumes from its own account.
    if (props.looplabsAccountId) {
      const invoker = new iam.Role(this, "LoopLabsInvoker", {
        assumedBy: new iam.AccountPrincipal(props.looplabsAccountId),
        externalIds: props.looplabsExternalId ? [props.looplabsExternalId] : undefined,
        description: "Assumed by LoopLabs to invoke the customer-ops AgentCore runtime",
      });
      runtime.grantInvoke(invoker);
      new CfnOutput(this, "LoopLabsInvokerRoleArn", { value: invoker.roleArn });
    }

    new CfnOutput(this, "AgentRuntimeArn", { value: runtime.agentRuntimeArn });
    new CfnOutput(this, "SecretArn", { value: secret.secretArn });
    new CfnOutput(this, "TableName", { value: table.tableName });
  }
}
