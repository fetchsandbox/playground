"""AWS CDK stack: API Gateway + Lambdas + DynamoDB + Step Functions.

Deploy:
  cd infra && pip install -r requirements.txt
  npx aws-cdk synth
  npx aws-cdk deploy
"""

from __future__ import annotations

from pathlib import Path

from aws_cdk import (
    CfnOutput,
    Duration,
    RemovalPolicy,
    Stack,
    aws_apigateway as apigw,
    aws_dynamodb as dynamodb,
    aws_lambda as lambda_,
    aws_logs as logs,
    aws_stepfunctions as sfn,
    aws_stepfunctions_tasks as tasks,
)
from constructs import Construct

ROOT = Path(__file__).resolve().parents[1]
SRC = str(ROOT / "src")


class CustomerOpsStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)

        table = dynamodb.Table(
            self,
            "WorkflowTable",
            partition_key=dynamodb.Attribute(name="pk", type=dynamodb.AttributeType.STRING),
            sort_key=dynamodb.Attribute(name="sk", type=dynamodb.AttributeType.STRING),
            billing_mode=dynamodb.BillingMode.PAY_PER_REQUEST,
            removal_policy=RemovalPolicy.DESTROY,
        )
        table.add_global_secondary_index(
            index_name="gsi1",
            partition_key=dynamodb.Attribute(name="gsi1pk", type=dynamodb.AttributeType.STRING),
            sort_key=dynamodb.Attribute(name="gsi1sk", type=dynamodb.AttributeType.STRING),
            projection_type=dynamodb.ProjectionType.ALL,
        )

        common_env = {
            "CUSTOMER_OPS_TABLE": table.table_name,
            # Set to 0 in prod secrets; mocks keep synth/demo safe without vendor keys.
            "CUSTOMER_OPS_USE_MOCKS": "1",
        }

        bundling = {
            "image": lambda_.Runtime.PYTHON_3_12.bundling_image,
            "command": [
                "bash",
                "-c",
                "pip install pydantic httpx boto3 -t /asset-output && cp -au . /asset-output",
            ],
        }
        code = lambda_.Code.from_asset(SRC, bundling=bundling)

        agent_fn = lambda_.Function(
            self,
            "AgentRunner",
            runtime=lambda_.Runtime.PYTHON_3_12,
            handler="customer_ops.handlers.agent_runner.handler",
            code=code,
            timeout=Duration.seconds(60),
            memory_size=512,
            environment=common_env,
            log_retention=logs.RetentionDays.ONE_WEEK,
        )
        table.grant_read_write_data(agent_fn)

        finalize_fn = lambda_.Function(
            self,
            "Finalize",
            runtime=lambda_.Runtime.PYTHON_3_12,
            handler="customer_ops.handlers.finalize.handler",
            code=code,
            timeout=Duration.seconds(30),
            environment=common_env,
            log_retention=logs.RetentionDays.ONE_WEEK,
        )
        table.grant_read_write_data(finalize_fn)

        def agent_task(construct_id: str, agent: str) -> tasks.LambdaInvoke:
            task = tasks.LambdaInvoke(
                self,
                construct_id,
                lambda_function=agent_fn,
                payload=sfn.TaskInput.from_object(
                    {
                        "workflow_id.$": "$.workflow_id",
                        "idempotency_key.$": "$.idempotency_key",
                        "request.$": "$.request",
                        "agent": agent,
                    }
                ),
                result_path=f"$.results.{agent}",
                retry_on_service_exceptions=True,
            )
            task.add_retry(
                errors=["States.TaskFailed", "Lambda.ServiceException", "Lambda.TooManyRequestsException"],
                interval=Duration.seconds(2),
                max_attempts=3,
                backoff_rate=2.0,
            )
            task.add_catch(
                sfn.Pass(
                    self,
                    f"{construct_id}Caught",
                    parameters={
                        "agent": agent,
                        "status": "failed",
                        "error.$": "$.Error",
                        "cause.$": "$.Cause",
                    },
                    result_path=f"$.results.{agent}",
                ),
                errors=["States.ALL"],
            )
            return task

        research = agent_task("ResearchAgent", "research")
        quote = agent_task("QuoteAgent", "quote")
        billing = agent_task("BillingAgent", "billing")
        handoff = agent_task("HandoffAgent", "handoff")
        survey = agent_task("SurveyAgent", "survey")

        finalize = tasks.LambdaInvoke(
            self,
            "FinalizeWorkflow",
            lambda_function=finalize_fn,
            payload=sfn.TaskInput.from_object(
                {
                    "workflow_id.$": "$.workflow_id",
                }
            ),
            result_path="$.finalize",
        )

        # Research → Parallel(Quote ‖ Billing) → Handoff → Survey → Finalize
        # Each agent Task has Catch so a single vendor outage soft-fails the branch.
        parallel = (
            sfn.Parallel(self, "QuoteAndBilling", result_path="$.parallel")
            .branch(quote)
            .branch(billing)
        )
        parallel.add_catch(
            sfn.Pass(self, "ParallelSoftFail", result_path="$.parallel_error"),
            errors=["States.ALL"],
        )

        definition = research.next(parallel).next(handoff).next(survey).next(finalize)

        state_machine = sfn.StateMachine(
            self,
            "CustomerOpsSM",
            definition_body=sfn.DefinitionBody.from_chainable(definition),
            timeout=Duration.minutes(15),
            tracing_enabled=True,
        )

        slack_fn = lambda_.Function(
            self,
            "SlackTrigger",
            runtime=lambda_.Runtime.PYTHON_3_12,
            handler="customer_ops.handlers.slack_trigger.handler",
            code=code,
            timeout=Duration.seconds(30),
            environment={
                **common_env,
                "STATE_MACHINE_ARN": state_machine.state_machine_arn,
            },
            log_retention=logs.RetentionDays.ONE_WEEK,
        )
        table.grant_read_write_data(slack_fn)
        state_machine.grant_start_execution(slack_fn)

        api = apigw.RestApi(
            self,
            "CustomerOpsApi",
            rest_api_name="customer-ops-workflow",
            deploy_options=apigw.StageOptions(stage_name="prod"),
        )
        slack = api.root.add_resource("slack")
        events = slack.add_resource("events")
        commands = slack.add_resource("commands")
        integration = apigw.LambdaIntegration(slack_fn)
        events.add_method("POST", integration)
        commands.add_method("POST", integration)

        CfnOutput(self, "ApiUrl", value=api.url)
        CfnOutput(self, "SlackEventsUrl", value=f"{api.url}slack/events")
        CfnOutput(self, "SlackCommandsUrl", value=f"{api.url}slack/commands")
        CfnOutput(self, "StateMachineArn", value=state_machine.state_machine_arn)
        CfnOutput(self, "TableName", value=table.table_name)
