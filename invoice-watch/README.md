# invoice-watch

BDK playground agent: **Gmail invoice → Google Calendar cancel reminder + Slack alert**.

## Source of truth (providers)

| Provider | Spec / SDK |
| --- | --- |
| Gmail | [Gmail MCP](https://developers.google.com/workspace/gmail/api/reference/mcp) (`search_threads`, `get_message`) · [messages.list/get REST](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list) |
| Google Calendar | [Calendar MCP `create_event`](https://developers.google.com/workspace/calendar/api/v3/reference/mcp/tools_list/create_event) · [events.insert REST](https://developers.google.com/calendar/api/v3/reference/events/insert) |
| Slack | [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage) · `@slack/web-api` |

Authored tools under `bot/tools/` build those exact request shapes
(`mcpArguments` / `apiArguments`) and also emit `restEquivalent` for
inspection. **FetchSandbox twins are for verification only** — they do
not redefine the workflow schema.

## Flow

1. Trigger from a pasted email, Slack mention, or `poll-invoices` schedule.
2. Extract merchant, amount, renewal / cancel-by dates.
3. Dedupe with `check_invoice_processed` / `record_processed_invoice`.
4. `create_cancel_calendar_event` → Google Calendar MCP `create_event`.
5. `post_slack_invoice_alert` → Slack `chat.postMessage`.

## Setup

```bash
cd invoice-watch
npm install
npx @cursor/bdk login   # model turns
```

**Gmail / Calendar auth (pick one):**

1. **Direct Google MCP URLs (declared in-repo):**
   `bot/mcp-connections/gmail.ts` → `https://gmailmcp.googleapis.com/mcp/v1`
   `bot/mcp-connections/google-calendar.ts` → `https://calendarmcp.googleapis.com/mcp/v1`
   Google does not support OAuth dynamic client registration — follow
   Google’s configure-MCP guides (OAuth client with “AI-powered agent”).
2. **Cursor account connectors:** connect Gmail + Google Calendar in the
   MCP dashboard / Workspace plugins, add
   `bot/mcp-connections/account.ts` with
   `defineConnection({ cursorAccount: true, servers: ["Gmail", "Google Calendar"], advertiseTools: true, optional: true })`,
   then `npx @cursor/bdk login`. Authored tools still send the same
   official `search_threads` / `get_message` / `create_event` shapes.

**Slack (Web API SDK):**

```bash
npx @cursor/bdk slack create --dir . --name "Invoice Watch"
```

## Run

```bash
npx @cursor/bdk validate --dir .
npx @cursor/bdk info --dir . --json
npx @cursor/bdk call create_cancel_calendar_event --dir . --input '{
  "merchant":"Notion","amount":"$29.00 USD","cancelBy":"2026-11-12",
  "renewalDate":"2026-11-15","invoiceId":"INV-1001"
}'
npx @cursor/bdk dev --dir .
```

### Dry-run / twin verification

Dry-run stubs writes but still returns the real provider payloads:

```bash
npx @cursor/bdk run --dir . --dry-run --message "Dry-run: process sample-invoice.txt; show create_event and chat.postMessage payloads."
```

Point FetchSandbox twins at the `restEquivalent` URLs/bodies from those
tool results to verify behavior — not to redesign the contracts.

Disposable HTTP driver for managed-tunnel / caller-executed checks.
Observation endpoints return keyed collections for FetchSandbox selectors
(`invoices[*]`, `webhooks[*]`):

```bash
# Env from validate_integration legs (+ optional FETCHSANDBOX_VERIFIER_TOKEN)
node verify/twin-driver.mjs
curl -sS -X POST http://127.0.0.1:8788/process-invoice \
  -H 'content-type: application/json' \
  -d '{"merchant":"Notion","amount":"$29.00 USD","cancelBy":"2026-11-12","renewalDate":"2026-11-15","invoiceId":"INV-1001","channel":"C0BILLING01"}'
# → GET /runs/{run_id}/invoices  { "invoices": [ ... ] }
# → GET /webhooks                { "webhooks": [ ... ] }
```

Submit the behavioral contract (baseline + provider faults + messy Slack
webhooks) and let FetchSandbox drive the tunnel:

```bash
# Requires ~/.fetchsandbox/credentials.json from device auth
node verify/run-proof-receipt.mjs
# writes /tmp/fs-proof-final.json and /tmp/fs-proof-receipt-url.txt
```

Latest FetchSandbox proof receipt (managed tunnel, disposable twin-driver):

https://fetchsandbox.com/runs/33ea90a77f?flow=vr_bcf2db427531446b9de854b02d82d319

Held: baseline, duplicate, Slack/Gmail/Calendar faults, unsigned webhook
rejection. Typed `observation_missing` blockers retained for signed Slack
event replay/withheld (direct delivery published no signing headers /
`webhook_subscriptions`).

## Schedules

`bot/schedules/poll-invoices.md` every 4 hours (manual under `--dev`):

```bash
curl -X POST http://127.0.0.1:3000/invoice-watch/v1/dev/schedules/poll-invoices
```

## Checks

```bash
npm run check
npx @cursor/bdk eval --dir . --list
npx @cursor/bdk eval --dir . --tag smoke
```
