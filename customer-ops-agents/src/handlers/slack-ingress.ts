import { ExecutionAlreadyExists, SFNClient, SendTaskSuccessCommand, StartExecutionCommand } from "@aws-sdk/client-sfn";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { getDeps, loadSecrets } from "../deps";
import type { TaskCallbacks } from "../workflow/approval";
import { type Starter, handleIngress } from "./ingress-core";

const sfn = new SFNClient({});

const starter: Starter = {
  async start(name, input) {
    try {
      await sfn.send(new StartExecutionCommand({ stateMachineArn: process.env.STATE_MACHINE_ARN, name, input: JSON.stringify(input) }));
    } catch (err) {
      // Same name, different input, or a finished execution: it's a duplicate delivery — already handled.
      if (err instanceof ExecutionAlreadyExists) return;
      throw err;
    }
  },
};

const callbacks: TaskCallbacks = {
  async success(taskToken, output) {
    await sfn.send(new SendTaskSuccessCommand({ taskToken, output: JSON.stringify(output) }));
  },
};

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const [secrets, deps] = await Promise.all([loadSecrets(), getDeps()]);
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : (event.body ?? "");
  const res = await handleIngress(
    { path: event.rawPath, headers: event.headers, rawBody },
    { signingSecret: secrets.SLACK_SIGNING_SECRET, deps, starter, callbacks },
  );
  return { statusCode: res.status, body: res.body ?? "", headers: res.headers };
}
