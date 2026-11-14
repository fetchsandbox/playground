# Catering quote to booking: verification record

Sanitized evidence for the [catering-quote workflow](../workflows/catering-quote.md)
([design](../workflows/catering-quote-design.md)). Synthetic identities only
(`*@party.example.test`, `owner@tonys-pizza.example.test`); no live provider
accounts, keys or customer data were used. Recorded 2026-11-14.

## What was run

- **App:** the real AgentCore container entry point (`acme-ops/dist/main.mjs`,
  `WORKFLOW=catering-quote`) on a loopback port, reached by FetchSandbox through
  the managed relay; provider clients bound to isolated FetchSandbox twins of
  **Stripe, HubSpot, Gmail and Google Calendar**, credentials via the protected
  handoff (never printed or committed).
- **Runner:** `cd acme-ops && npm run bundle && node verify/relay-proof.mjs catering-quote`
  (FetchSandbox MCP `0.7.30`, suite `application_workflow_v1`).
- **Contract:** [`acme-ops/verify/contracts/catering-quote.mjs`](../../acme-ops/verify/contracts/catering-quote.mjs):
  29 checks (26 executable, 3 declared `setup_missing` blockers), all 17
  coverage dimensions reviewed.
- **Fixture:** one existing event on the owner's twin calendar at the
  date-conflict slot, read back through `freeBusy` before the run.
- **Local tests:** `npm run check && npm test` → 373 passed (18 in
  `test/catering-quote.test.ts`, incl. the controlled-clock reminder and expiry).

## Attempts (all kept; none edited)

| # | App version (declared) | Receipt | Result | What changed next |
|---|---|---|---|---|
| 1 | `acme-ops-catering-quote-1.0.0-1b363af` | [vr_df2bbe2e…](https://fetchsandbox.com/runs/b18653b341?flow=vr_df2bbe2ecfb744d5b78768a9b7f043fe) | baseline **unmeasured**; other 25 executable checks not run | **Contract form.** `eq()` makes a nested `actions[*]` predicate required on *every* action, so `detail.amountDue` (only on the invoice action) read as missing. Saved app state showed every baseline step applied with `amountDue: 57500`. Element-specific fields now compared without the per-element requirement; values unchanged. |
| 2 | `…-ecea639` | [vr_fb5af031…](https://fetchsandbox.com/runs/f8942e0f7f?flow=vr_fb5af0316147447fb51fea2691f8b71a) | 21 held · **2 violated** · 6 unmeasured | **Contract form.** `duplicate_start`/`concurrent_start` pinned the `duplicateStarts` redelivery counter, which grows when the verifier re-drives a check (1→3, 4→9) while the app kept one run and one send (`attempts: 1`); now asserts the one-effect invariants instead. `superseded`/`booked_inquiry` selected runs by `input.revision`, which the run view doesn't expose; now by `output.quoteId`. Gmail read-back dropped `?format=metadata`. |
| 3 | `…-38cc9cd` | [vr_fc7b58f6…](https://fetchsandbox.com/runs/405903a833?flow=vr_fc7b58f615764623bb1ffc45d3c35802) | 24 held · **1 violated** · 4 unmeasured | **App bug found.** `booked_inquiry_not_requoted`: after r1 was accepted and booked, the r2 counter-offer saw its *own* booking as a kitchen conflict and was queued as a "date unavailable" decline to an already-booked customer. Fixed in `d5973a6` (already-booked inquiries always go to the owner); regression test written first and observed failing. |
| 4 | `…-7aa9614` | [**vr_6d113a8a…**](https://fetchsandbox.com/runs/86863f3bc0?flow=vr_6d113a8a1bd84198bc1280c1e457bacc) | **25 held · 0 violated · 4 unmeasured** (verdict *inconclusive*) | Same checks as attempt 3 plus independent provider read-back assertions (below). This is the current receipt. |

Attempt 3 → 4 is the **same-contract proof of the fix** for
`booked_inquiry_not_requoted` (violated → held). The only contract addition in
attempt 4 is provider read-back assertions on four checks; no check was
removed, renamed or weakened.

## Attempt 4 in detail

Held (25): `baseline`, `stranger_cannot_approve`, `owner_rejects_quote`,
`customer_declines`, `stranger_cannot_accept`, `accept_before_quote_sent_ignored`,
`negotiated_within_floor`, `counter_below_floor_countered`,
`superseded_revision_not_accepted`, `booked_inquiry_not_requoted`,
`headcount_below_minimum_declined`, `short_notice_declined`,
`date_conflict_declined`, `large_party_to_owner`, `invalid_input_rejected`,
`duplicate_start`, `concurrent_start`, `concurrent_acceptance`,
`gmail_send_rejected_then_resumed`, `gmail_lookup_unavailable_not_resent`,
`calendar_unavailable_to_owner`, `stripe_unavailable_to_owner`,
`hubspot_down_quote_continues`, `restart_awaiting_acceptance` (real process
restart, same storage), `booking_reconciled_reminder_not_early`.

Verifier provider read-backs (from saved twin records, per the public summary):
baseline Stripe invoice 1/1, Gmail messages 2/2 (quote + confirmation),
Calendar event 1/1; `gmail_send_rejected_then_resumed` Gmail 1/1;
`gmail_lookup_unavailable_not_resent` Gmail 1/1.

Unmeasured (4):

| Check | Why | Other evidence (not verifier-attested) |
|---|---|---|
| `gmail_response_lost_recovered` | Verifier: "Accepted response read-back needs an accepted write, observed client disconnect and subsequent direct read of the same provider effect" (`missing_evidence`). Its matcher did not credit the app's `rfc822msgid:` search + `GET messages/{id}` sequence. | App state: `gmail.send_quote` applied, `attempts: 1`, `recovered: true`, ~8.5 s after approval (the 8 s client timeout). My own read of the session's Gmail twin store: exactly **1** message to that recipient. |
| `reminder_sent_day_before` | `setup_missing`: fires at event − 24 h; the runtime uses the real clock and the run budget is < 1 h. | Scheduled time asserted (held) in `booking_reconciled_reminder_not_early`; firing, content and skip-if-cancelled covered by the controlled-clock local test. |
| `quote_expires_unaccepted` | `setup_missing`: needs the clock to pass the 7-day hold. | Controlled-clock local test. |
| `inbound_reply_starts_or_accepts` | `setup_missing`: reply parsing is the intake adapter's job, outside this runtime; Gmail twin has no `history`/`watch`. | None. |

### Independent twin read-back (my observation of session `vs_3d4cdc6baff8`)

Read through `validate_integration inspect` after the run; complete collections
(Gmail 28/28 messages, Stripe 9/9 invoices, Calendar 9/9 events):

- **Calendar:** 7 catering events, one per accepted booking, each with popup
  reminders at 1 440 and 120 minutes; the superseded inquiry booked only r2
  ($16.00/person); plus the seeded conflict and one twin fixture event.
- **Stripe:** 7 open `send_invoice` invoices keyed by `metadata.catering_quote`,
  $575.00 or $515.00 as quoted; one for four concurrent acceptances; none for
  the superseded r1.
- **Gmail:** never a duplicate. One quote for the rejected-then-resumed, lost-
  response and lookup-down cases; quote + one confirmation for concurrent
  acceptance and restart; two quotes (r1, r2) + one confirmation for the
  superseded inquiry; no second quote for the already-booked inquiry.

## Scope limits

- Twin evidence: simulated provider behaviour and a simulated mailbox. It does
  not prove Gmail OAuth consent, real inbox delivery, Stripe's invoice email,
  live calendar sharing, or a deployed AgentCore runtime (none was deployed).
- `app_version` is declared, not attested; the receipt's state endpoint is not
  storage-attested (verifier limitations `app_version_is_declared_not_attested`,
  `application_state_endpoint_not_storage_attested`).
- No SMS path yet; no deposit/balance split; HubSpot deal pipeline not used
  (twin: deal create limited to one profile, no PATCH/search).
- Not every production scenario is covered; see the design note's limits.
