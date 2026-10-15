---
description: Use when a subscription invoice, renewal notice, or receipt arrives (pasted, forwarded, or found in Gmail) and you should create a cancel reminder on Google Calendar plus a Slack alert.
---

# Process a subscription invoice

## Extract

From the email (body or Gmail message), pull:

| Field | Notes |
| --- | --- |
| `merchant` | Product or billing brand |
| `amount` | Include currency if present |
| `invoiceId` | Invoice / charge / receipt id when present |
| `renewalDate` | Next charge or period end; ISO date if possible |
| `cancelBy` | Explicit cancel deadline, else 3 days before renewal |
| `source` | `gmail:<messageId>` or `paste:<stable fingerprint>` |

Build `invoiceKey` as lowercase:

`{merchant}|{invoiceId or renewalDate}|{amount}`

Strip spaces around `|` segments. Example:
`notion|inv_123|29.00 usd`.

## Dedupe

Call `check_invoice_processed` with that `invoiceKey`.

- If `processed: true`, reply with the stored calendar/Slack refs and
  stop. Do not create another event or Slack post.
- If not processed, continue.

## Calendar

Using Google Calendar MCP tools:

1. Create an event titled `Cancel {merchant} subscription`.
2. Schedule it on `cancelBy` (all-day or morning local time).
3. Description should include amount, renewal date, invoice id, and a
  short “why cancel” note from the email subject/body.
4. Keep the event private to the connected calendar.

## Slack

Using Slack MCP tools:

1. Post to the channel the user named, or the default watch channel if
  one is configured in the conversation.
2. Message shape:

   ```
   Subscription invoice: {merchant} — {amount}
   Renews: {renewalDate} · Cancel by: {cancelBy}
   Calendar reminder created. Invoice key: {invoiceKey}
   ```

3. Do not @channel or @here unless the user asked.

## Record

Call `record_processed_invoice` with:

- `invoiceKey`, `merchant`, `amount`, `renewalDate`, `cancelBy`
- `calendarEventId` / `slackMessageRef` when the MCP calls returned them
- `source`
- `dryRun: true` when the session stubbed writes (or the user asked for
  a plan-only / dry-run pass)

## Gmail scan (schedule or “check inbox”)

1. Search recent mail for subscription / invoice / renewal / receipt
  signals (last 7 days unless the user gives another window).
2. Skip threads that look like marketing or password resets.
3. Process each new hit with this skill, one invoice at a time.
4. Summarize: processed / skipped-duplicate / ignored counts.

## Dry-run / twin validation

If the user says dry-run, plan-only, or FetchSandbox twin:

- Still extract fields and call `check_invoice_processed`.
- Prefer read-only MCP calls. Do not rely on live writes succeeding.
- Call `record_processed_invoice` with `dryRun: true` and any stub ids
  the harness returned so the trajectory stays inspectable.
- Report the exact Calendar and Slack payloads you would send.
