import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import type { Construct } from "constructs";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (f: string) => path.join(here, "..", "src", f);

// Error names thrown by src/lib/errors.ts. Keep in sync.
const TRANSIENT = ["RetryableError", "LeaseBusyError", "EffectInProgressError"];
const LAMBDA_TRANSIENT = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException", "Lambda.TooManyRequestsException"];

export interface CustomerOpsProps extends StackProps {
  /** Comma-separated Slack user ids allowed to approve (empty = anyone). */
  approverUserIds?: string;
  defaultOwnerId?: string;
  claudeModel?: string;
}

export class CustomerOpsStack extends Stack {
  constructor(scope: Construct, id: string, props: CustomerOpsProps = {}) {
    super(scope, id, props);

    // --- State: idempotency ledger, leases, approvals, rate limits --------
    const table = new dynamodb.Table(this, "State", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Fill after deploy: aws secretsmanager put-secret-value (see README).
    const secret = new secretsmanager.Secret(this, "Secrets", {
      description: "customer-ops-agents API credentials (JSON). See README for keys.",
    });

    const env = {
      TABLE_NAME: table.tableName,
      SECRET_ARN: secret.secretArn,
      CLAUDE_MODEL: props.claudeModel ?? "claude-opus-5-5",
      APPROVER_USER_IDS: props.approverUserIds ?? "",
      DEFAULT_OWNER_ID: props.defaultOwnerId ?? "",
      NODE_OPTIONS: "--enable-source-maps",
    };

    const fn = (name: string, entry: string, handler: string, timeout: Duration, memorySize = 512) => {
      const f = new NodejsFunction(this, `${name}Fn`, {
        entry: src(entry),
        handler,
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize,
        timeout,
        environment: env,
        tracing: lambda.Tracing.ACTIVE,
        logGroup: new logs.LogGroup(this, `${name}Logs`, { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
        bundling: { minify: true, sourceMap: true, target: "node22" },
      });
      table.grantReadWriteData(f);
      secret.grantRead(f);
      return f;
    };

    const steps = "handlers/steps.ts";
    const fns = {
      intake: fn("Intake", steps, "intake", Duration.minutes(2)),
      research: fn("Research", steps, "research", Duration.minutes(5), 1024),
      quote: fn("Quote", steps, "quote", Duration.minutes(3)),
      billing: fn("Billing", steps, "billing", Duration.minutes(3)),
      survey: fn("Survey", steps, "survey", Duration.minutes(2)),
      handoff: fn("Handoff", steps, "handoff", Duration.minutes(3)),
      requestApproval: fn("RequestApproval", steps, "requestApproval", Duration.seconds(30)),
      dispatch: fn("Dispatch", steps, "dispatch", Duration.minutes(3)),
      notify: fn("Notify", steps, "notify", Duration.seconds(30)),
    };

    // --- State machine ------------------------------------------------------
    const invoke = (id: string, f: lambda.IFunction, extra: Partial<tasks.LambdaInvokeProps> = {}) => {
      const t = new tasks.LambdaInvoke(this, id, { lambdaFunction: f, payloadResponseOnly: true, retryOnServiceExceptions: false, ...extra });
      t.addRetry({ errors: LAMBDA_TRANSIENT, interval: Duration.seconds(1), backoffRate: 2, maxAttempts: 4, jitterStrategy: sfn.JitterType.FULL });
      t.addRetry({ errors: TRANSIENT, interval: Duration.seconds(3), backoffRate: 2, maxAttempts: 5, maxDelay: Duration.minutes(1), jitterStrategy: sfn.JitterType.FULL });
      t.addRetry({ errors: [sfn.Errors.TIMEOUT], interval: Duration.seconds(5), maxAttempts: 1 });
      return t;
    };

    const notify = (id: string, kind: string) =>
      invoke(id, fns.notify, { payload: sfn.TaskInput.fromObject({ kind, state: sfn.JsonPath.entirePayload }), resultPath: sfn.JsonPath.DISCARD });

    const notifyFailed = notify("NotifyFailed", "failed").next(new sfn.Fail(this, "Failed", { error: "WorkflowFailed" }));
    const catchToFailure = (t: tasks.LambdaInvoke) => t.addCatch(notifyFailed, { errors: [sfn.Errors.ALL], resultPath: "$.error" });

    const intake = catchToFailure(invoke("Intake", fns.intake, { taskTimeout: sfn.Timeout.duration(Duration.minutes(2)) }));

    // Each branch isolates its own failure: a failed agent becomes a
    // {status:"failed"} result instead of failing the whole Parallel state.
    const branch = (name: string, f: lambda.IFunction, flag: string) => {
      const task = invoke(`${name}Agent`, f, { taskTimeout: sfn.Timeout.duration(Duration.minutes(5)) });
      task.addCatch(
        new sfn.Pass(this, `${name}Failed`, {
          parameters: { agent: name.toLowerCase(), status: "failed", "error.$": "$.Error", "cause.$": "$.Cause" },
        }),
        { errors: [sfn.Errors.ALL] },
      );
      const skipped = new sfn.Pass(this, `${name}Skipped`, { result: sfn.Result.fromObject({ agent: name.toLowerCase(), status: "skipped" }) });
      return new sfn.Choice(this, `${name}Needed?`).when(sfn.Condition.booleanEquals(flag, true), task).otherwise(skipped);
    };

    const fanOut = new sfn.Parallel(this, "FanOutAgents", { resultPath: "$.agents" })
      .branch(branch("Research", fns.research, "$.intake.tasks.research"))
      .branch(branch("Quote", fns.quote, "$.intake.tasks.quote.needed"))
      .branch(branch("Billing", fns.billing, "$.intake.tasks.billing"))
      .branch(branch("Survey", fns.survey, "$.intake.tasks.survey"));

    const handoff = catchToFailure(invoke("HandoffAgent", fns.handoff));

    const requestApproval = new tasks.LambdaInvoke(this, "WaitForHumanApproval", {
      lambdaFunction: fns.requestApproval,
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: sfn.TaskInput.fromObject({ taskToken: sfn.JsonPath.taskToken, state: sfn.JsonPath.entirePayload }),
      resultPath: "$.approval",
      taskTimeout: sfn.Timeout.duration(Duration.hours(24)),
    });
    requestApproval.addRetry({ errors: [...LAMBDA_TRANSIENT, ...TRANSIENT], interval: Duration.seconds(2), backoffRate: 2, maxAttempts: 4, jitterStrategy: sfn.JitterType.FULL });
    requestApproval.addCatch(notify("NotifyExpired", "expired").next(new sfn.Succeed(this, "Expired")), { errors: [sfn.Errors.TIMEOUT], resultPath: "$.error" });
    requestApproval.addCatch(notifyFailed, { errors: [sfn.Errors.ALL], resultPath: "$.error" });

    const dispatch = catchToFailure(invoke("DispatchApprovedActions", fns.dispatch, { taskTimeout: sfn.Timeout.duration(Duration.minutes(3)) }));

    const decision = new sfn.Choice(this, "Approved?")
      .when(sfn.Condition.stringEquals("$.approval.decision", "approve"), dispatch.next(notify("NotifyDone", "done")).next(new sfn.Succeed(this, "Done")))
      .otherwise(notify("NotifyRejected", "rejected").next(new sfn.Succeed(this, "Rejected")));

    const definition = intake.next(fanOut).next(handoff).next(requestApproval).next(decision);

    const machine = new sfn.StateMachine(this, "CustomerOpsWorkflow", {
      stateMachineType: sfn.StateMachineType.STANDARD, // exactly-once state transitions + name-based dedupe
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: Duration.hours(26),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, "WorkflowLogs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
        level: sfn.LogLevel.ERROR,
      },
    });

    // --- Slack ingress -------------------------------------------------------
    const ingress = fn("SlackIngress", "handlers/slack-ingress.ts", "handler", Duration.seconds(10), 1024);
    ingress.addEnvironment("STATE_MACHINE_ARN", machine.stateMachineArn);
    machine.grantStartExecution(ingress);
    machine.grantTaskResponse(ingress);

    const api = new HttpApi(this, "SlackApi", { description: "Slack → customer-ops-agents" });
    const integration = new HttpLambdaIntegration("SlackIngressIntegration", ingress);
    for (const p of ["/slack/commands", "/slack/events", "/slack/interactions"]) {
      api.addRoutes({ path: p, methods: [HttpMethod.POST], integration });
    }

    // --- Alarms ---------------------------------------------------------------
    new cloudwatch.Alarm(this, "WorkflowFailures", {
      metric: machine.metricFailed({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: "customer-ops workflow executions failed",
    });

    new CfnOutput(this, "SlackRequestUrlBase", { value: `${api.apiEndpoint}/slack` });
    new CfnOutput(this, "SecretArn", { value: secret.secretArn });
    new CfnOutput(this, "StateMachineArn", { value: machine.stateMachineArn });
  }
}
