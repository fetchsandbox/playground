# Zendesk cancellation reply bridge

This stack continues **existing** `cxl_refund_offer` tickets. It also accepts explicit `cancel subscription sub_…` Slack DM/mention commands
through the existing signature-verified Acme Slack queue. It does not implement
new email cancellation intake, change refund policy, or grant
LoopLabs execution permissions. The business runtime remains independently deployed.

Flow: Zendesk public-comment trigger → HMAC-verified HTTP endpoint → encrypted SQS
FIFO → one delivery worker → canonical Zendesk ticket/comment/requester lookup →
AgentCore `refund_choice` with `zd-<ticket>-reply-<comment>` as the stable run ID.
The webhook JSON is `{ "ticket_id": "{{ticket.id}}" }`; no email body or customer
identity is accepted from webhook JSON. The worker rejects CCs, private notes,
agent/bot responses, and tickets without an open cancellation refund offer.

The latest public comment must be from the requester. Before invoking AgentCore,
the worker saves the exact command keyed by webhook invocation ID. This survives a
lost response or a later bot comment, and lets delivery resume recoverable failed
actions under the same run ID. Runtime failures are retried by SQS; after five
receives they remain in the dead-letter queue for review. Parked approvals are
valid delivery checkpoints, not completed refunds. Approval handling is unchanged.

Retention: logs and both queues 14 days; private command ledger TTL 7 days (AWS TTL
deletion is asynchronous). The ledger is encrypted by DynamoDB and retained by
CloudFormation. It stores the minimum runtime command, including requester email;
logs contain only IDs, phase/decision and deployment version. No credentials,
comment bodies or gift-card numbers are logged by the bridge.

The separate secret contains only Zendesk OAuth client fields scoped at token
issuance to `tickets:read users:read`, the webhook signing secret and routing
configuration. It contains no Stripe, Slack or Square token. The worker can invoke
only the configured cancellation runtime and its DEFAULT endpoint. Ingress cannot
invoke AgentCore. Configure Zendesk's signing secret before enabling the trigger;
missing/invalid/expired signatures are rejected. The five-minute timestamp bound
uses the exact raw request body and Zendesk's documented HMAC-SHA256 format.

Deploy separately, without rebuilding the business runtime:

```sh
npx cdk deploy AcmeCancellationDelivery --app 'npx tsx infra/cancellation-delivery.ts' \
  -c runtimeArn=YOUR_CANCELLATION_RUNTIME_ARN --profile fetchsandbox
```

Populate `ConfigSecretArn` privately with `ZENDESK_SUBDOMAIN`, `ZENDESK_CLIENT_ID`,
`ZENDESK_CLIENT_SECRET`, `ZENDESK_SCOPES`, `webhook_signing_secret`, `ops_channel`,
`approvers`, and optional `gift_card_location_id`. Configure a Zendesk trigger for
public comments on tickets tagged `cxl_refund_offer`, excluding `cxl_refunded`.
The worker independently verifies authorship; trigger conditions are not trusted
as the only security boundary. Activating that connection requires account-admin
permission. Existing workflow output may queue notifications that are safely ignored.

Focused tests: run `python -m unittest discover -s infra/cancellation_delivery` in
an environment with boto3. They are bridge tests; they do not establish native
email delivery or full workflow acceptance. See the saved deployment receipts for
exact measured scope, blocked checks and live versions.

Slack routing checks the configured workspace, reads requester email from Slack,
and binds each event to a durable command. Typed email addresses are not trusted.
A processing reply is updated in the originating thread after completion. Quote
and refund events retain their previous routing. A separate Slack-token secret is
readable by the delivery worker only; the existing shared worker receives only
SendMessage permission to this queue. The runtime accepts an honest Slack channel
value and optional thread timestamp. Subscription owner email is checked against
the actual Stripe customer; ticket-specific offers are resolved across same-email
customer records rather than selecting an arbitrary one.
