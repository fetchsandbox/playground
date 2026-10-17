import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { App, Stack, CfnOutput, RemovalPolicy, Tags } from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as destinations from 'aws-cdk-lib/aws-lambda-destinations';
import { Duration } from 'aws-cdk-lib';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
const app=new App();
const stack=new Stack(app,'AcmeRefundOperations',{env:{account:process.env.CDK_DEFAULT_ACCOUNT,region:process.env.CDK_DEFAULT_REGION}});
const version='acme-refund-1.0.5';
const commit=app.node.tryGetContext('sourceCommit')??'unrecorded';
for(const [k,v] of Object.entries({organization:'Acme Corporation',department:'Customer Service and Revenue Operations',owner:'Raj',owner_team:'Refund Assurance',environment:'production',workflow:'refund-operations',deployment_version:version,source_commit:commit,policy_version:'2026-10-17.1',synthetic_demo:'true',oncall:'rnagulapalle'}))Tags.of(stack).add(k,v);
const table=new dynamodb.Table(stack,'Cases',{partitionKey:{name:'pk',type:dynamodb.AttributeType.STRING},billingMode:dynamodb.BillingMode.PAY_PER_REQUEST,timeToLiveAttribute:'ttl',pointInTimeRecoverySpecification:{pointInTimeRecoveryEnabled:true},removalPolicy:RemovalPolicy.RETAIN});
const bucket=new s3.Bucket(stack,'PolicyEvidence',{versioned:true,encryption:s3.BucketEncryption.S3_MANAGED,blockPublicAccess:s3.BlockPublicAccess.BLOCK_ALL,enforceSSL:true,removalPolicy:RemovalPolicy.RETAIN});
const secret=new secretsmanager.Secret(stack,'Providers',{description:'Acme Refund Operations demo provider credentials; Stripe TEST mode only'});
const runtime=new agentcore.Runtime(stack,'Runtime',{
 runtimeName:'acme_refund_operations',
 description:'Acme Corporation | production | Customer Service and Revenue Operations | Owner: Raj | Refund Assurance | Six specialist agents verify purchase, product/return evidence and versioned S3 policies; eligible refunds <20% automatic, 20%-70% approval, above70% declined; refund original test payment and notify customer. Synthetic demo; no live money.',
 agentRuntimeArtifact:agentcore.AgentRuntimeArtifact.fromAsset(path.join(path.dirname(fileURLToPath(import.meta.url)),'../../acme-refund-operations'),{platform:Platform.LINUX_ARM64}),
 protocolConfiguration:agentcore.ProtocolType.HTTP,
 authorizerConfiguration:agentcore.RuntimeAuthorizerConfiguration.usingIAM(),
 environmentVariables:{DYNAMODB_TABLE:table.tableName,POLICY_BUCKET:bucket.bucketName,CONFIG_SECRET_ARN:secret.secretArn,APPROVER_USER_IDS:'U0AHZ0RCM',REFUND_MANAGER_CHANNEL:'D0C9D1N6S5B',ADOT_ENABLED:'true',WORKFLOW_ORGANIZATION:'Acme Corporation',WORKFLOW_OWNER:'Raj',WORKFLOW_OWNER_ORGANIZATION:'Acme Customer Service and Revenue Operations',WORKFLOW_OWNER_TEAM:'Refund Assurance',WORKFLOW_DEPARTMENT:'Customer Service and Revenue Operations',WORKFLOW_ENVIRONMENT:'production',WORKFLOW_DEPLOYMENT_VERSION:version,WORKFLOW_SOURCE_COMMIT:commit,WORKFLOW_POLICY_VERSION:'2026-10-17.1',WORKFLOW_POLICY_CATALOG:'s3://'+bucket.bucketName+'/catalog.json',WORKFLOW_ONCALL:'rnagulapalle'},
 tracingEnabled:true,manageDeliveryResourcePolicy:false,
});
table.grantReadWriteData(runtime);bucket.grantRead(runtime);secret.grantRead(runtime);
new CfnOutput(stack,'AgentRuntimeArn',{value:runtime.agentRuntimeArn});
new CfnOutput(stack,'PolicyBucket',{value:bucket.bucketName});new CfnOutput(stack,'PolicyCatalogUri',{value:'s3://'+bucket.bucketName+'/catalog.json'});
new CfnOutput(stack,'SecretArn',{value:secret.secretArn});new CfnOutput(stack,'TableName',{value:table.tableName});

const failures=new sqs.Queue(stack,'DeliveryFailures',{retentionPeriod:Duration.days(14),enforceSSL:true});
const delivery=new lambda.Function(stack,'Delivery',{runtime:lambda.Runtime.PYTHON_3_12,handler:'delivery_worker.handler',code:lambda.Code.fromAsset(path.join(path.dirname(fileURLToPath(import.meta.url)),'../../acme-refund-operations/verify')),
 timeout:Duration.seconds(180),memorySize:256,logRetention:logs.RetentionDays.TWO_WEEKS,environment:{REFUND_RUNTIME_ARN:runtime.agentRuntimeArn,REFUND_DEPLOYMENT_VERSION:version},retryAttempts:2,onFailure:new destinations.SqsDestination(failures)});
delivery.addToRolePolicy(new iam.PolicyStatement({actions:['bedrock-agentcore:InvokeAgentRuntime'],resources:[runtime.agentRuntimeArn,runtime.agentRuntimeArn+'/runtime-endpoint/DEFAULT']}));
new CfnOutput(stack,'DeliveryFunction',{value:delivery.functionName});new CfnOutput(stack,'DeliveryFunctionArn',{value:delivery.functionArn});
new CfnOutput(stack,'DeliveryFailureQueue',{value:failures.queueUrl});

// This workflow owns its mailbox intake; it does not depend on the quote app's Google push configuration.
new events.Rule(stack,'ScopedEmailIntake',{description:'Acme Refund Operations: scan only operations@fetchsandbox.com / Acme refund mail each minute',schedule:events.Schedule.rate(Duration.minutes(1)),targets:[new targets.LambdaFunction(delivery,{event:events.RuleTargetInput.fromObject({action:'poll_email'}),retryAttempts:2,maxEventAge:Duration.hours(1)})]});
