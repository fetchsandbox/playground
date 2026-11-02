# Deploying a workflow: AWS, Google Cloud, Snowflake

Every workflow is the same container: an HTTP server on `:8080` with
`POST /invocations` and `GET /ping`. What changes between clouds is where its
run state, secrets, policy and timer live.

| | AWS Bedrock AgentCore | Google Cloud Run | Snowflake SPCS | Any container host |
|---|---|---|---|---|
| Template | [`infra/`](../infra) (CDK) | [`gcp-cloud-run/service.yaml`](gcp-cloud-run/service.yaml) | [`snowflake-spcs/`](snowflake-spcs) | `docker run` |
| Image | `linux/arm64` (built by CDK) | `linux/amd64` | `linux/amd64` | either |
| Run state | DynamoDB (`DYNAMODB_TABLE`), many instances | `STATE_FILE` on a Cloud Storage volume, one instance | `STATE_FILE` on block storage, one instance | `STATE_FILE` |
| Secrets | Secrets Manager (`SECRET_ARN`) | Secret Manager → env | Snowflake secrets → env | env / `.env` |
| Policy override | `-c policyFile:<wf>=file.json` → `POLICY_JSON` | Secret Manager volume → `POLICY_FILE` | Stage volume → `POLICY_FILE` | `POLICY_FILE` / `POLICY_JSON` |
| Timers (`tick`) | EventBridge Scheduler | in-process (`TICK_INTERVAL_MS`, CPU always on) | in-process (`TICK_INTERVAL_MS`) | `TICK_INTERVAL_MS` |
| Callers | `InvokeAgentRuntime` (IAM or JWT) | HTTPS with Cloud Run IAM | SQL service function (`/snowflake/invocations`) | HTTP |

Build the image once per workflow:

```bash
cd acme-ops
docker build --platform linux/amd64 --build-arg WORKFLOW=<workflow> -t <registry>/acme-ops/<workflow>:<tag> .
```

## Run state beyond one instance

The engine needs one thing from a store: compare-and-swap writes
(`KvStore` in [`src/kit/store.ts`](../src/kit/store.ts)). DynamoDB is built
in. `FileStore` is safe only with a single writer, which is why the Cloud Run
and SPCS templates pin one instance.

To scale out on another cloud, write a `KvStore` over a store with conditional
writes (Firestore transactions, Cloud SQL / AlloyDB / Postgres
`UPDATE … WHERE version = $1`, Snowflake hybrid tables, Azure Cosmos DB
`If-Match`). Prove it with the conformance suite before it holds real runs:

```ts
// test/my-store.test.ts
import { kvStoreConformance } from "./conformance/kv-store";
kvStoreConformance("postgres", async () => new PostgresStore(process.env.TEST_DATABASE_URL!));
```

Then select it in [`src/main.ts`](../src/main.ts) next to `DYNAMODB_TABLE`.

## What has and hasn't been exercised

- The AWS stack synthesizes, and the runtime contract is tested locally and
  through FetchSandbox relays. This project has not deployed it to a live AWS
  account.
- The Cloud Run and SPCS templates are starting points written from each
  platform's documented specification format. They have not been deployed by
  this project. Check them against your organization's networking and IAM
  rules.
- The Snowflake service-function adapter (`/snowflake/invocations`) is tested
  locally with the documented row-batch format.
