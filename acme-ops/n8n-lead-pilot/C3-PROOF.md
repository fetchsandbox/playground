# C3: hold a rejected Gmail send, then recover explicitly

The [November 7 receipt](https://fetchsandbox.com/runs/63d0624d55?flow=vr_6e00ef2d5af44542b29056646591be18)
held C0, C1, C2, C3 rejection and C3 explicit recovery: **five checks held, nine
unmeasured; overall inconclusive**. Recovery is a supplemental check of the same
C3 business case, not a fifth business use case. All 25 independent provider-state
assertions held. See [the sanitized observation](evidence/2026-11-07-c3-deployed-observation.json).

The actual published n8n workflow ran executions 29–37. Rejection/replay were
34/35; explicit recovery/completed replay were 36/37. Native execution pages 34
and 36 independently named published version `abd2c751-c25e-459f-99c4-4616910156e6`.
No app decision-source change was needed for C3. The adapter bundle and C0/C1/C2
check definitions were unchanged from the prior C2 measurement.

## What was measured

1. FetchSandbox armed `direct_send_rejected_once` on this run's isolated Gmail
   twin. It targets `gmail.users.messages.send`, returns 403 before mutation, and
   applies once. Other operations do not consume it. Local and public component
   checks established that the next valid direct send succeeds.
2. The standard MCP suite invoked the protected published webhook. The application
   created one Contact and one associated Deal, positively read the Deal back,
   and attempted a Gmail send. The provider archive recorded that exact POST as
   403. The application saved Gmail as failed and Calendar as pending.
3. FetchSandbox invoked the same lead again **without** `retry_failed`. The
   application stayed failed. There was no second Gmail request, even though the
   once-only rejection was already consumed. Independent state reads established
   one Contact, one Deal, **zero messages and zero Calendar events** before recovery.
   Each failed incoming execution emitted a failed-at-Gmail Slack notification:
   two in total. This is not a global notification-deduplication claim.
4. The suite's existing cleanup disarmed the fault between checks. The recovery
   check first read the existing failed state, then invoked the same lead with
   `retry_failed:true`. It made no new HubSpot calls, retained both CRM IDs, sent
   one email, created one Calendar event and posted one confirmed notification.
5. A completed replay added no effects. Independent final reads established one
   Contact, one correctly associated Deal, one Gmail message, one Calendar event
   and three Slack notifications: two earlier failures and one confirmation.

The two phase checks prevent a final successful state from hiding an earlier
unsafe write. Application `/proof` claims were checked separately from provider
collections. The archive windows also show one Gmail 403 before recovery, then
one Gmail 200 and one Calendar POST during recovery, with no CRM calls in that
second window. No per-check branches or fabricated provider effects were added
to the application.

## Deployment and regression scope

Backend `a952b218` enables the mounted Gmail scenario configuration. Runtime
image bytes are identical to the preceding deployment; across 260 configuration
files only `gmail/scenarios.yaml` changed. Environment values stayed identical
except build metadata. No schema, account, signing-key or n8n source change was
part of this release. Published MCP remains `0.7.30`.

The targeted backend gate passed 80 tests with one not-applicable parameter
skipped. Workflow tests passed 434 tests across 65 files; TypeScript passed. The
public component smoke independently measured rejection/no-mutation followed by
success/read-back, existing Gmail draft/direct behavior, and the existing
HubSpot C2 timeout/read-back control. Those component results remain separate
from this n8n receipt.

Four owned twin sandboxes were deleted with HTTP 200; the snapshot remained
readable afterward. Temporary binding credentials were removed. This cleanup
observation does not satisfy the full C11 fresh-session isolation contract.

## What this does not establish

C4–C12 remain unmeasured. The full quality milestone also needs deliberately
broken workflow controls, three clean full-contract repetitions and fresh native
builder acceptance. Native Gmail authorization, real mail delivery, Calendar
invitations, SaaS-node parity, per-requester identity and crash recovery are not
proved by this run. C2's separate negative-control work is tracked in
[C2-PROOF.md](C2-PROOF.md).

The measured transport remains MCP → managed relay → protected local adapter →
published n8n webhook; n8n Cloud I/O returns through separate ngrok HTTPS. The
unchanged measured native export was reused. A later editor export had identical
six nodes and connections but different draft metadata; it was not substituted
into this historical receipt. Source-capture automation remains deferred until
case verification, as requested.
