import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, RemovalPolicy, Stack, type StackProps, Tags } from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

const projectDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface WorkflowStackProps extends StackProps {
  workflow: string;
  containerRepository?: string;
  containerTag?: string;
  org: string;
  team: string;
  description: string;
  sourceCommit: string;
  deploymentVersion: string;
  /** Disable only after checking a regional shared delivery policy exists. */
  manageDeliveryResourcePolicy?: boolean;
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
    for (const [key, value] of Object.entries({ organization: "Acme", company: "Acme Corporation", environment: "production", owner: "Raj", owner_organization: `Acme ${props.org} Operations`, department: props.org, owner_team: props.team, oncall_status: "unassigned", source_commit: props.sourceCommit, deployment_version: props.deploymentVersion })) Tags.of(this).add(key, value);
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
      description: `Acme Corporation | production | ${props.org} | Owner: Raj | ${props.team} | ${props.description}`.slice(0, 1000),
      agentRuntimeArtifact: props.containerRepository && props.containerTag
        ? agentcore.AgentRuntimeArtifact.fromEcrRepository(ecr.Repository.fromRepositoryName(this, "ContainerRepository", props.containerRepository), props.containerTag)
        : agentcore.AgentRuntimeArtifact.fromAsset(projectDir, {
        platform: Platform.LINUX_ARM64,
        buildArgs: { WORKFLOW: props.workflow },
      }),
      protocolConfiguration: agentcore.ProtocolType.HTTP,
      authorizerConfiguration: props.jwtDiscoveryUrl
        ? agentcore.RuntimeAuthorizerConfiguration.usingJWT(props.jwtDiscoveryUrl, props.jwtAllowedClients)
        : agentcore.RuntimeAuthorizerConfiguration.usingIAM(),
      environmentVariables: {
        WORKFLOW: props.workflow,
        WORKFLOW_ORGANIZATION: "Acme",
        WORKFLOW_COMPANY_NAME: "Acme Corporation",
        WORKFLOW_ENVIRONMENT: "production",
        WORKFLOW_OWNER: "Raj",
        WORKFLOW_DEPARTMENT: props.org,
        GMAIL_FROM_IDENTITY: `Acme ${props.org} <${props.org === "Sales" ? "sales" : "operations"}@fetchsandbox.com>`,
        GMAIL_REPLY_TO: `${props.org === "Sales" ? "sales" : "operations"}@fetchsandbox.com`,
        WORKFLOW_OWNER_TEAM: props.team,
        WORKFLOW_ONCALL_STATUS: "unassigned",
        WORKFLOW_DEPLOYMENT_VERSION: props.deploymentVersion,
        WORKFLOW_SOURCE_COMMIT: props.sourceCommit,
        DYNAMODB_TABLE: table.tableName,
        SECRET_ARN: secret.secretArn,
        ANTHROPIC_MODEL: props.claudeModel ?? "claude-opus-5-5",
        APPROVER_USER_IDS: props.approverUserIds ?? "",
        APPROVAL_TTL_HOURS: String(props.approvalTtlHours ?? 24),
      },
      tracingEnabled: true,
      // The deployment may reuse a verified regional policy to avoid consuming
      // one account-level quota slot per workflow. Default CDK behavior is kept
      // for accounts without that preconfigured delivery permission.
      manageDeliveryResourcePolicy: props.manageDeliveryResourcePolicy,
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
