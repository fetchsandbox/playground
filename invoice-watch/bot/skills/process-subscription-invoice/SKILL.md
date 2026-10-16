---
description: Use when a subscription invoice, renewal notice, or receipt arrives (pasted, forwarded, or found in Gmail) and you should create a cancel reminder on Google Calendar plus a Slack alert using real provider API contracts.
---

# Process a subscription invoice

## Provider source of truth

| Step | Provider contract | Authored tool |
| --- | --- | --- |
| Find mail | Gmail MCP `search_threads` ([spec](https://developers.google.com/workspace/gmail/api/reference/mcp/tools_list/search_threads)); REST `users.messages.list` `q` | `search_gmail_invoices` |
| Read mail | Gmail MCP `get_message` ([spec](https://developers.google.com/workspace/gmail/api/reference/mcp/tools_list/get_message)); REST `users.messages.get` | `get_gmail_message` |
| Reminder | Calendar MCP `create_event` ([spec](https://developers.google.com/workspace/calendar/api/v3/reference/mcp/tools_list/create_event)); REST `events.insert` | `create_cancel_calendar_event` |
| Alert | Slack Web API `chat.postMessage` ([spec](https://docs.slack.dev/reference/methods/chat.postMessage)) | `post_slack_invoice_alert` |

Read `references/provider-contracts.md` for field-level shapes. Do not
substitute twin/fake schemas when building requests.

## Extract

From the email (body or Gmail message), pull:

| Field | Notes |
| --- | --- |
| `merchant` | Product or billing brand |
| `amount` | Include currency if present |
| `invoiceId` | Invoice / charge / receipt id when present |
| `renewalDate` | Next charge or period end; ISO date if possible |
| `cancelBy` | Explicit cancel deadline, else 3 days before renewal (`YYYY-MM-DD`) |
| `source` | `gmail:<messageId>` or `paste:<stable fingerprint>` |

Build `invoiceKey` as lowercase:

`{merchant}|{invoiceId or renewalDate}|{amount}`

Example: `notion|inv_123|29.00 usd`.

## Dedupe

Call `check_invoice_processed` with that `invoiceKey`.

- If `processed: true`, reply with the stored calendar/Slack refs and stop.
- If not processed, continue.

## Calendar (real `create_event`)

Call `create_cancel_calendar_event` with merchant, amount, `cancelBy`
(`YYYY-MM-DD`), optional renewal/invoice/notes.

The tool builds official MCP args (`summary`, `startTime`, `endTime`,
`calendarId`, `description`, `visibility`) and the parallel
`events.insert` REST body. Prefer the tool result over hand-rolling.

## Slack (real `chat.postMessage`)

Call `post_slack_invoice_alert` with `channel` (ID preferred), merchant,
amount, `invoiceKey`, and optional renewal/cancel/calendar ids.

The tool builds `{ channel, text, unfurl_links, unfurl_media }` per
Slack Web API and posts through `@slack/web-api`. Do not @channel/@here
unless asked.

## Record

Call `record_processed_invoice` with extracted fields plus
`calendarEventId` / `slackMessageRef` from the provider tools when present.
Set `dryRun: true` only when writes were stubbed.

## Gmail scan (schedule or “check inbox”)

1. `search_gmail_invoices` (default query uses Gmail operators + `newer_than`).
2. For promising hits, `get_gmail_message` with `FULL_CONTENT`.
3. Skip marketing / password resets.
4. Process each new invoice with this skill.
5. Summarize processed / skipped-duplicate / ignored counts.

## Verification only (FetchSandbox / dry-run)

After the workflow is built against the real contracts above, you may
verify behavior with:

- `bdk run --dry-run` (stubs write tools; returns real `mcpArguments` /
  `apiArguments` / `restEquivalent`)
- FetchSandbox twins pointed at the same REST shapes for before/after
  receipts

Twins never redefine the request schema. If a twin disagrees with the
official provider docs, the provider docs win.
