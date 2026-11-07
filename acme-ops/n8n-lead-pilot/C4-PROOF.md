# C4: recover a Gmail send after acceptance but lost response

The [November 7 receipt](https://fetchsandbox.com/runs/1826dab130?flow=vr_9b377a85e00d47a6b28890f0129f5ca8)
held C0/C1/C2, both C3 phases and C4: **six checks held, eight unmeasured;
overall inconclusive**. All 30 independent provider-state assertions held.
See [the sanitized observation](evidence/2026-11-07-c4-deployed-observation.json).
The C0/C1/C2/C3 check definitions were unchanged from commit `118fd98`.

This uses actual published native n8n executions with isolated provider twins.
It does not establish native Gmail delivery, Calendar invitations, SaaS outage
parity or fresh builder-agent acceptance. No backend runtime change or new
production release was required: backend `a952b218` already had the exact control;
published MCP remains `0.7.30`. The adapter bundle was unchanged.

## Observed sequence

1. FetchSandbox armed `direct_send_accepted_response_loss` for this run's Gmail
   twin and invoked the authenticated persistent n8n webhook. The fault targets
   `gmail.users.messages.send`, applies once and holds the response for 10 seconds
   **after the normal message mutation**. It does not replace acceptance with 503
   or add provider idempotency.
2. n8n created and confirmed the Contact and associated Deal. Gmail committed
   message `8931861818197059` at `17:18:12Z`. The server archived a real client
   disconnect at `17:18:18Z`. The application returned unknown with Gmail unknown
   and Calendar pending; no Calendar request occurred in this first execution.
3. FetchSandbox invoked the same lead again without an explicit resend flag.
   n8n searched by RFC Message-ID, then directly fetched the accepted message at
   `17:18:23Z`. The decision machine required its SENT label, exact recipient and
   Message-ID before confirming it. CRM identities remained unchanged.
4. Calendar creation followed at `17:18:24Z`. Independent provider-state checks
   established one Contact, one correctly associated Deal, **one Gmail message
   and one Calendar event**, with unknown-at-Gmail and final-confirmed Slack
   notifications. A third, completed replay made no provider requests.

The existing accepted-response-readback evidence gate requires the archived
accepted write, actual client disconnect, direct GET of that same effect after
disconnect, and **no second write** to that provider operation. Final app claims
are checked separately from provider collections. The intermediate unknown state
and Calendar ordering above are retained trace/archive observations; they are not
additional independently counted contract checks.

Native executions 56–67 ran the unchanged normal source. C4 used 65–67; n8n's
execution 66 independently named version
`064da74d-7ba5-4679-9d00-1efe7bb0b264`. The receipt's export hash is a declared
source reference, not a cryptographic attestation of every native runtime instant.

## Component and local gates remain separate

The deployed exact-operation component test observed a six-second client timeout,
accepted-message read-back, recorded disconnect, and a deliberately repeated
send creating a second message. The local socket/evidence gate also rejects that
repeated-write pattern. This qualifies the modeled fault and evidence boundary;
it is not a native n8n broken-workflow receipt.

The relevant existing backend gate passed 40 tests with one not-applicable
parameter skipped. Workflow tests passed 436 tests across 65 files; TypeScript
passed. No backend source or provider behavior was changed for C4.

The first public component observation queried the archive before its fixed
10-second hold finished, so the disconnect witness was not yet persisted. That
attempt failed and was retained, with its owned sandbox deleted. A fresh attempt
used a bounded wait for the server-recorded observation and passed. The initial
adapter build command also omitted its required output argument and failed
before building; the corrected command produced the unchanged bundle. Neither
setup failure is counted as a passing test or an application fix.

## Negative control and remaining quality gates

The registered `blind-gmail-resend` variant changes unknown-message reconciliation
into a second direct-send POST. It has no check-ID branch, fabricated response or
oracle changes. Local source/auth-guard tests pass. Its actual native failing
receipt remains unmeasured: the Mac relocked after publication, while saving its
native export. The variant was not invoked. The normal source was republished
immediately; no generated export was relabeled as an actual native capture.

C4's full quality milestone remains open until that control is rejected through
native n8n under this same business contract, followed by restoration proof.
C5–C12, remaining negative controls, three clean full-contract repetitions and
fresh native builder acceptance also remain unmeasured. Source-capture automation
is deferred by the owner until case verification.

The first normal run's four owned twin sandboxes were deleted with HTTP 200 and
its snapshot remained readable afterward. This does not satisfy the full C11
fresh-session isolation contract. The measured transport remains MCP → managed
relay → local protected adapter → native n8n webhook; n8n Cloud I/O returns over
separate ngrok HTTPS. No live Gmail, Calendar or Slack delivery was used.

## Restored normal source recheck

The normal workflow was republished as
`03207059-cc93-4ab8-834e-bcb70e46b2ce`. The
[separate restored receipt](https://fetchsandbox.com/runs/b9c6ab0f24?flow=vr_356d50ccd6824e6ea7e08638b0e257ff)
held the same six checks, with eight unmeasured and all 30 independent provider
state assertions held. Its 14 business checks exactly match the initial C4 run.
Native executions 68–79 ran; page 78 independently named the restored version.
See [the restored observation](evidence/2026-11-07-c4-restored-observation.json).

The original actual normal export was reused for the restored identical decision
code/wiring; its historical version metadata was not rewritten. No fresh native
export was available. The new version was observed separately in execution
history, and the receipt's app version remains a declared source reference.
This is a normal-source recheck, not a failing native negative-control receipt.

Four owned twins were deleted for each normal run, both snapshots remained
readable, temporary bindings were removed, and the local adapter and temporary
ngrok process stopped. C4's remaining native mutation gate needs the pending
actual export saved on the unlocked Mac, then a separately identified publication
and execution of that source under this unchanged contract, followed by normal
restoration and another measured receipt. No new credentials are required by the
observed blocker. No substitute source capture or generated active flag was used.

To repeat the local gates from their respective repository roots, use:

```sh
python -m pytest backend/tests/test_n8n_provider_fault_controls.py backend/tests/test_gmail_workflow_contract.py backend/tests/test_gmail_message_listing.py -q
npm --prefix acme-ops run check
npm --prefix acme-ops test
```

Use the existing private native-export/bindings handoff and standard
`verify/relay-proof.mjs n8n-lead-recovery` lifecycle for the runtime measurement.
Select `PILOT_VARIANT=blind-gmail-resend` only for a separately published,
actually captured matching native source. The normal path remains `normal`.
Do not alter the 14 business checks or invert expected verdicts for the mutant;
retain its separate failing receipt and restore normal source afterward.
