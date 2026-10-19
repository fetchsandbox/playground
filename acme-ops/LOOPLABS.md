# Cancellation connection to LoopLabs

## Observation and shared decisions

The native runtime can emit the bounded `business-events 1.0` format when its
administrator configures `LOOPLABS_CONTROL_CONFIG` and a signing key in the
existing private secret. The configuration binds the tenant, AWS connection,
runtime ARN, deployment version, epoch and an explicit email-to-native-reviewer
mapping. Missing configuration leaves this adapter disabled. Raw messages,
customer inputs and provider results are not copied into these events. The optional version-scoped CloudWatch forwarder separates typed events from
general diagnostics. It turns malformed business records into redacted coverage
gaps instead of hiding them. General logs stay in their original source.

New adapter-enrolled runs save their events and exact approval snapshot with the
native DynamoDB state. The signed bridge exposes only those runs from the exact
configured scope; it does not enroll historical runs or grant authority through
log discovery. Decisions recheck the frozen input, agent outputs, planned action
summaries, policy binding, expiry and existing native approvers at the run's
compare-and-swap. A conflicting first decision wins once; a repeated saved
approval does not execute a second effect. Local concurrency fixtures do not by
themselves prove a native Slack/LoopLabs race.

Deploy the native code and verify its actual version before installing the
matching LoopLabs binding. A fixed API Gateway relay must invoke a reviewed,
version-pinned AgentCore endpoint, verify no paths from caller input and make
no automatic mutation retry. Signing material stays on the servers. Existing
self-review behavior must be explicit; this adapter does not establish independent
review or change product cancellation/refund terms.

For a Slack demo, the deployed intake expects `cancel subscription sub_…`.
Natural-language variants may fall through to another handler; verify the exact
installed router. The separate Demo Shop purchase/refund flow belongs to the
six-role refund workflow, not this cancellation workflow. Customer refund-method
selection continues through the requester-authenticated Zendesk email reply.

Focused adapter tests: `npm test -- --run test/looplabs-control.test.ts`.
Fresh native, browser and provider acceptance must be recorded separately; this
section describes the contract and does not certify a deployed connection.

The forwarder accepts only the exact source account/log group and writes to its
derived `-business-vN` group. It preserves event IDs for observer deduplication,
uses one write attempt, and has no runtime invoke or provider permissions. Its
subscription matches the reported deployment version; it does not convert
ordinary diagnostic text into workflow evidence. Native delivery, reader access
and the selected source must be verified separately.
